// 引用计数 + 循环回收引擎（与 main.py 语义逐条对应，确定性）。
// 原生 ES module，无第三方依赖。

export class ScriptError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

export const OP_ARITY = {
  new: 1,
  pin: 1,
  unpin: 1,
  ref: 2,
  unref: 2,
  collect: 0,
};

export function normalize(line) {
  return line.trim().split(/\s+/).join(" ");
}

export function parse(tokens) {
  const op = tokens[0];
  const arity = OP_ARITY[op];
  if (arity === undefined || tokens.length - 1 !== arity) {
    throw new ScriptError("syntax");
  }
  for (let i = 1; i < tokens.length; i++) {
    if (!NAME_RE.test(tokens[i])) throw new ScriptError("syntax");
  }
  return [op, tokens.slice(1)];
}

// 把脚本全文解析成语句序列（跳过空行与注释），步号从 1 起。
export function parseScript(text) {
  const statements = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const stmt = normalize(raw);
    try {
      const [op, args] = parse(stmt.split(" "));
      statements.push({ step: statements.length + 1, stmt, op, args });
    } catch (e) {
      if (!(e instanceof ScriptError)) throw e;
      statements.push({ step: statements.length + 1, stmt, op: null, error: e.code });
    }
  }
  return statements;
}

export class Engine {
  constructor() {
    this.objs = new Map(); // name -> {ext, inc, out: Map}
    this.used = new Set();
    this.queue = [];
    this.queued = new Set();
    this.cycleLog = []; // {step, freed:[...], cycles}
  }

  missing(name) {
    throw new ScriptError(this.used.has(name) ? "dead" : "unknown");
  }

  enqueue(name) {
    if (!this.queued.has(name)) {
      this.queued.add(name);
      this.queue.push(name);
    }
  }

  drain(events) {
    const objs = this.objs;
    while (this.queue.length > 0) {
      const name = this.queue.shift();
      this.queued.delete(name);
      const obj = objs.get(name);
      objs.delete(name);
      events.push("-" + name);
      const targets = [...obj.out.keys()].sort();
      for (const tgt of targets) {
        const tgtObj = objs.get(tgt);
        if (tgtObj === undefined) continue;
        tgtObj.inc -= obj.out.get(tgt);
        if (tgtObj.ext + tgtObj.inc === 0) this.enqueue(tgt);
      }
      obj.out.clear();
    }
  }

  execute(op, args, events, step = 0) {
    const objs = this.objs;
    if (op === "new") {
      const name = args[0];
      if (this.used.has(name)) throw new ScriptError("redefine");
      this.used.add(name);
      objs.set(name, { ext: 1, inc: 0, out: new Map() });
      events.push("+" + name);
    } else if (op === "pin") {
      const obj = objs.get(args[0]);
      if (obj === undefined) this.missing(args[0]);
      obj.ext += 1;
    } else if (op === "unpin") {
      const name = args[0];
      const obj = objs.get(name);
      if (obj === undefined) this.missing(name);
      if (obj.ext === 0) throw new ScriptError("underflow");
      obj.ext -= 1;
      if (obj.ext + obj.inc === 0) {
        this.enqueue(name);
        this.drain(events);
      }
    } else if (op === "ref") {
      const [a, b] = args;
      const src = objs.get(a);
      if (src === undefined) this.missing(a);
      const dst = objs.get(b);
      if (dst === undefined) this.missing(b);
      src.out.set(b, (src.out.get(b) || 0) + 1);
      dst.inc += 1;
    } else if (op === "unref") {
      const [a, b] = args;
      const src = objs.get(a);
      if (src === undefined) this.missing(a);
      const dst = objs.get(b);
      if (dst === undefined) this.missing(b);
      const cnt = src.out.get(b) || 0;
      if (cnt === 0) throw new ScriptError("noedge");
      if (cnt === 1) src.out.delete(b);
      else src.out.set(b, cnt - 1);
      dst.inc -= 1;
      if (dst.ext + dst.inc === 0) {
        this.enqueue(b);
        this.drain(events);
      }
    } else {
      this.collect(events, step);
    }
  }

  collect(events, step) {
    const objs = this.objs;
    const marked = new Set();
    const stack = [];
    for (const [name, obj] of objs) {
      if (obj.ext > 0) {
        marked.add(name);
        stack.push(name);
      }
    }
    while (stack.length > 0) {
      const obj = objs.get(stack.pop());
      for (const tgt of obj.out.keys()) {
        if (!marked.has(tgt)) {
          marked.add(tgt);
          stack.push(tgt);
        }
      }
    }
    const garbage = [...objs.keys()].filter((n) => !marked.has(n)).sort();
    if (garbage.length === 0) return;
    const cycles = countCycleGroups(objs, garbage);
    for (const name of garbage) this.enqueue(name);
    this.drain(events);
    this.cycleLog.push({ step, freed: garbage, cycles });
  }
}

// D 内每个节点的入边都来自 D，故每个弱连通分量恰含至少一个环；
// 分量数即本次回收的环数。
function countCycleGroups(objs, garbage) {
  const parent = new Map();
  for (const name of garbage) parent.set(name, name);
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) {
      const next = parent.get(x);
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const inGarbage = new Set(garbage);
  for (const name of garbage) {
    for (const tgt of objs.get(name).out.keys()) {
      if (inGarbage.has(tgt)) {
        const ra = find(name);
        const rb = find(tgt);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const roots = new Set();
  for (const name of garbage) roots.add(find(name));
  return roots.size;
}

// 对象分类：名字去掉尾部数字，如 t001 -> t、k1 -> k、hub -> hub。
export function classOf(name) {
  return name.replace(/[0-9]+$/, "");
}

// 完整回放一遍，产出轨迹与每步统计（供时间轴曲线与环回收清单使用）。
export function replayAll(statements) {
  const engine = new Engine();
  const steps = [];
  let error = null;
  for (const s of statements) {
    const events = [];
    if (s.op === null) {
      events.push("!" + s.error);
      error = s.error;
    } else {
      try {
        engine.execute(s.op, s.args, events, s.step);
      } catch (e) {
        if (!(e instanceof ScriptError)) throw e;
        events.length = 0;
        events.push("!" + e.code);
        error = e.code;
      }
    }
    const classCounts = Object.create(null);
    for (const name of engine.objs.keys()) {
      const cls = classOf(name);
      classCounts[cls] = (classCounts[cls] || 0) + 1;
    }
    steps.push({
      step: s.step,
      stmt: s.stmt,
      events,
      live: engine.objs.size,
      classCounts,
    });
    if (error !== null) break;
  }
  return { engine, steps, cycleLog: engine.cycleLog, error };
}
