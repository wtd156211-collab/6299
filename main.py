#!/usr/bin/env python3
"""确定性的引用计数 + 循环回收运行时。

只依赖 Python 3 标准库；不使用 gc / weakref。语义以仓库 README 为准：
单步操作均摊 O(1)，rc 归零立即按 FIFO 队列级联释放；collect 从所有
ext>0 的存活对象沿出边做可达标记，未标记部分按名字升序入队整体回收。
"""

import re
import sys
from collections import deque

NAME_RE = re.compile(r"[a-z][a-z0-9_]{0,31}\Z")

OP_ARITY = {
    "new": 1,
    "pin": 1,
    "unpin": 1,
    "ref": 2,
    "unref": 2,
    "collect": 0,
}


class ScriptError(Exception):
    """脚本语义或语法错误，code 为 README 规定的六个错误码之一。"""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class _Obj:
    __slots__ = ("ext", "inc", "out")

    def __init__(self):
        self.ext = 1
        self.inc = 0
        self.out = {}


def normalize(line):
    """去首尾空白、把连续空白压成单空格后的语句原文。"""
    return " ".join(line.split())


def parse(tokens):
    """校验操作名、参数个数与名字语法；返回 (op, [args])。"""
    op = tokens[0]
    arity = OP_ARITY.get(op)
    if arity is None or len(tokens) - 1 != arity:
        raise ScriptError("syntax")
    for name in tokens[1:]:
        if not NAME_RE.match(name):
            raise ScriptError("syntax")
    return op, tokens[1:]


class Engine:
    """引用计数对象表。对象表只保留存活对象。"""

    def __init__(self):
        self.objs = {}
        self.used = set()
        self._queue = deque()
        self._queued = set()

    def _missing(self, name):
        raise ScriptError("dead" if name in self.used else "unknown")

    def _enqueue(self, name):
        if name not in self._queued:
            self._queued.add(name)
            self._queue.append(name)

    def _drain(self, events):
        """FIFO 级联释放：出队即移出存活集合，出边按目标名升序处理。"""
        q = self._queue
        queued = self._queued
        objs = self.objs
        while q:
            name = q.popleft()
            queued.discard(name)
            obj = objs.pop(name)
            events.append("-" + name)
            out = obj.out
            for tgt in sorted(out):
                tgt_obj = objs.get(tgt)
                if tgt_obj is None:
                    continue
                tgt_obj.inc -= out[tgt]
                if tgt_obj.ext + tgt_obj.inc == 0:
                    self._enqueue(tgt)
            out.clear()

    def execute(self, op, args, events):
        """执行一条已通过 parse 校验的语句；事件追加进 events。"""
        objs = self.objs
        if op == "new":
            name = args[0]
            if name in self.used:
                raise ScriptError("redefine")
            self.used.add(name)
            objs[name] = _Obj()
            events.append("+" + name)
        elif op == "pin":
            obj = objs.get(args[0])
            if obj is None:
                self._missing(args[0])
            obj.ext += 1
        elif op == "unpin":
            name = args[0]
            obj = objs.get(name)
            if obj is None:
                self._missing(name)
            if obj.ext == 0:
                raise ScriptError("underflow")
            obj.ext -= 1
            if obj.ext + obj.inc == 0:
                self._enqueue(name)
                self._drain(events)
        elif op == "ref":
            a, b = args
            src = objs.get(a)
            if src is None:
                self._missing(a)
            dst = objs.get(b)
            if dst is None:
                self._missing(b)
            src.out[b] = src.out.get(b, 0) + 1
            dst.inc += 1
        elif op == "unref":
            a, b = args
            src = objs.get(a)
            if src is None:
                self._missing(a)
            dst = objs.get(b)
            if dst is None:
                self._missing(b)
            cnt = src.out.get(b, 0)
            if cnt == 0:
                raise ScriptError("noedge")
            if cnt == 1:
                del src.out[b]
            else:
                src.out[b] = cnt - 1
            dst.inc -= 1
            if dst.ext + dst.inc == 0:
                self._enqueue(b)
                self._drain(events)
        else:  # collect
            self._collect(events)

    def _collect(self, events):
        objs = self.objs
        marked = set()
        stack = []
        for name, obj in objs.items():
            if obj.ext > 0:
                marked.add(name)
                stack.append(name)
        while stack:
            obj = objs[stack.pop()]
            for tgt in obj.out:
                if tgt not in marked:
                    marked.add(tgt)
                    stack.append(tgt)
        garbage = sorted(objs.keys() - marked)
        for name in garbage:
            self._enqueue(name)
        if garbage:
            self._drain(events)


def run_lines(lines, trace_out, live_out=None):
    """逐行回放；返回 0 执行完毕、2 脚本出错。"""
    engine = Engine()
    step = 0
    for raw in lines:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        step += 1
        stmt = normalize(raw)
        events = []
        error = None
        try:
            op, args = parse(stmt.split())
        except ScriptError as exc:
            error = exc.code
        else:
            try:
                engine.execute(op, args, events)
            except ScriptError as exc:
                error = exc.code
        if error is not None:
            events = ["!" + error]
        trace_out.write(
            "%d %s -> %s\n" % (step, stmt, ",".join(events) if events else "-")
        )
        if live_out is not None:
            live = ",".join(sorted(engine.objs)) if engine.objs else "-"
            live_out.write("%d %s\n" % (step, live))
        if error is not None:
            return 2
    return 0


_USAGE = (
    "用法: python3 main.py <脚本路径> [--trace <路径|->] [--live <路径|->]\n"
    "  --trace 默认 -（stdout）；--live 默认不输出；两者不可同时为 -\n"
)


def _open_output(path):
    if path == "-":
        return sys.stdout
    return open(path, "w", encoding="utf-8", newline="\n")


def main(argv):
    trace_path = "-"
    live_path = None
    positional = []
    i = 1
    while i < len(argv):
        token = argv[i]
        if token in ("--trace", "--live"):
            if i + 1 >= len(argv):
                sys.stderr.write(_USAGE)
                return 1
            value = argv[i + 1]
            if token == "--trace":
                trace_path = value
            else:
                live_path = value
            i += 2
        elif token == "-h" or token == "--help":
            sys.stdout.write(_USAGE)
            return 0
        elif token.startswith("--"):
            sys.stderr.write(_USAGE)
            return 1
        else:
            positional.append(token)
            i += 1

    if len(positional) != 1:
        sys.stderr.write(_USAGE)
        return 1
    if trace_path == "-" and live_path == "-":
        sys.stderr.write("用法错误: --trace 与 --live 不能同时为 -\n")
        return 1
    if live_path is not None and trace_path == live_path:
        sys.stderr.write("用法错误: --trace 与 --live 不能写同一个文件\n")
        return 1

    script_path = positional[0]
    try:
        with open(script_path, "r", encoding="utf-8") as script_file:
            trace_out = _open_output(trace_path)
            live_out = _open_output(live_path) if live_path is not None else None
            try:
                return run_lines(script_file, trace_out, live_out)
            finally:
                if trace_path != "-":
                    trace_out.close()
                if live_out is not None and live_path != "-":
                    live_out.close()
    except OSError as exc:
        sys.stderr.write("读写失败: %s\n" % exc)
        return 1
    except UnicodeDecodeError as exc:
        sys.stderr.write("脚本不是合法 UTF-8: %s\n" % exc)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
