"""main.py 的验收与回归测试（标准库 unittest）。"""

import io
import os
import random
import subprocess
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import main as m

SCRIPTS = ROOT / "samples" / "scripts"
EXPECTED = ROOT / "samples" / "expected"


def run_script_text(text):
    """进程内回放，返回 (退出码, trace, live)。"""
    trace = io.StringIO()
    live = io.StringIO()
    rc = m.run_lines(text.splitlines(keepends=True), trace, live)
    return rc, trace.getvalue(), live.getvalue()


def run_cli(args, env=None):
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(ROOT / "main.py"), *args],
        capture_output=True,
        text=True,
        env=full_env,
    )


class SampleAcceptanceTest(unittest.TestCase):
    """验收口径 1：13 个样例与 samples/expected 逐字节一致。"""

    def test_all_samples_match_expected(self):
        scripts = sorted(SCRIPTS.glob("*.script"))
        self.assertEqual(13, len(scripts))
        for script in scripts:
            name = script.stem
            with self.subTest(sample=name):
                rc, trace, live = run_script_text(
                    script.read_text(encoding="utf-8")
                )
                exp_trace = (EXPECTED / (name + ".trace.txt")).read_text(
                    encoding="utf-8"
                )
                exp_live = (EXPECTED / (name + ".live.txt")).read_text(
                    encoding="utf-8"
                )
                self.assertEqual(exp_trace, trace, "trace 不一致")
                self.assertEqual(exp_live, live, "live 不一致")
                self.assertIn(rc, (0, 2))

    def test_error_samples_exit_2_via_cli(self):
        for name in ("07_after_free_ref", "13_bad_syntax"):
            with self.subTest(sample=name):
                proc = run_cli([str(SCRIPTS / (name + ".script")), "--trace", os.devnull])
                self.assertEqual(2, proc.returncode)

    def test_ok_sample_exit_0_via_cli(self):
        proc = run_cli([str(SCRIPTS / "01_self_loop.script"), "--trace", os.devnull])
        self.assertEqual(0, proc.returncode)


class CliTest(unittest.TestCase):
    def test_both_stdout_is_usage_error(self):
        proc = run_cli(
            [str(SCRIPTS / "01_self_loop.script"), "--trace", "-", "--live", "-"]
        )
        self.assertEqual(1, proc.returncode)

    def test_missing_script_is_io_error(self):
        proc = run_cli(["/nonexistent/x.script", "--trace", os.devnull])
        self.assertEqual(1, proc.returncode)

    def test_no_args_is_usage_error(self):
        self.assertEqual(1, run_cli([]).returncode)

    def test_trace_default_is_stdout(self):
        proc = run_cli([str(SCRIPTS / "01_self_loop.script")])
        self.assertEqual(0, proc.returncode)
        self.assertTrue(proc.stdout.startswith("1 new a -> +a\n"))

    def test_live_to_stdout(self):
        proc = run_cli(
            [str(SCRIPTS / "01_self_loop.script"), "--trace", os.devnull, "--live", "-"]
        )
        self.assertEqual("1 a\n2 a\n3 a\n4 -\n", proc.stdout)


class DeterminismTest(unittest.TestCase):
    """验收口径 2：不同 PYTHONHASHSEED 下输出逐字节相同。"""

    def test_hash_seed_independence(self):
        outputs = []
        for seed in ("0", "1", "2024"):
            proc = run_cli(
                [str(SCRIPTS / "05_churn.script"), "--trace", "-"],
                env={"PYTHONHASHSEED": seed},
            )
            outputs.append(proc.stdout)
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0], outputs[2])

    def test_repeat_runs_identical(self):
        first, _, _ = run_script_text((SCRIPTS / "03_long_cycle.script").read_text())
        second, _, _ = run_script_text((SCRIPTS / "03_long_cycle.script").read_text())
        self.assertEqual(first, second)


class ParserTest(unittest.TestCase):
    def test_crlf_and_comments_and_blank_lines(self):
        text = "# 注释\r\n\r\nnew a\r\n  \t \nref a a\r\nunpin a\ncollect\n"
        rc, trace, live = run_script_text(text)
        self.assertEqual(0, rc)
        self.assertEqual(
            "1 new a -> +a\n2 ref a a -> -\n3 unpin a -> -\n4 collect -> -a\n",
            trace,
        )

    def test_whitespace_collapsed_in_trace(self):
        _, trace, _ = run_script_text("new   a\nref\ta\tb\n")
        self.assertEqual("1 new a -> +a\n2 ref a b -> !unknown\n", trace)

    def test_trailing_comment_not_supported(self):
        _, trace, _ = run_script_text("new a # x\n")
        self.assertEqual("1 new a # x -> !syntax\n", trace)

    def test_bad_name_syntax(self):
        _, trace, _ = run_script_text("new A\n")
        self.assertEqual("1 new A -> !syntax\n", trace)

    def test_name_too_long(self):
        _, trace, _ = run_script_text("new " + "a" * 33 + "\n")
        self.assertTrue(trace.endswith("!syntax\n"))

    def test_unknown_op(self):
        _, trace, _ = run_script_text("del a\n")
        self.assertEqual("1 del a -> !syntax\n", trace)

    def test_error_statement_does_not_change_state(self):
        rc, trace, live = run_script_text("new a\nunpin a\nunpin a\nnew b\n")
        self.assertEqual(2, rc)
        self.assertEqual("1 a\n2 -\n3 -\n", live)


class InvariantTest(unittest.TestCase):
    """每步结束后校验：计数守恒、无悬挂引用、已释放对象不再出现。"""

    def check_invariants(self, engine):
        objs = engine.objs
        inc = {name: 0 for name in objs}
        for name, obj in objs.items():
            for tgt, cnt in obj.out.items():
                self.assertIn(tgt, objs, "悬挂引用 %s -> %s" % (name, tgt))
                self.assertGreater(cnt, 0)
                inc[tgt] += cnt
        for name, obj in objs.items():
            self.assertEqual(inc[name], obj.inc, "int 不守恒: %s" % name)
            self.assertGreater(obj.ext + obj.inc, 0, "rc<=0 却存活: %s" % name)

    def replay_checked(self, text):
        engine = m.Engine()
        step = 0
        for raw in text.splitlines():
            stripped = raw.strip()
            if not stripped or stripped.startswith("#"):
                continue
            step += 1
            events = []
            try:
                op, args = m.parse(m.normalize(raw).split())
                engine.execute(op, args, events)
            except m.ScriptError:
                break
            self.check_invariants(engine)
        return engine

    def test_samples_keep_invariants(self):
        for script in sorted(SCRIPTS.glob("*.script")):
            with self.subTest(sample=script.stem):
                self.replay_checked(script.read_text(encoding="utf-8"))

    def test_random_scripts_keep_invariants(self):
        rng = random.Random(20261003)
        for trial in range(30):
            lines = []
            live_names = []
            for _ in range(400):
                roll = rng.random()
                if roll < 0.3 or not live_names:
                    name = "o%d" % rng.randrange(60)
                    lines.append("new " + name)
                    live_names.append(name)
                elif roll < 0.5:
                    a = rng.choice(live_names)
                    b = rng.choice(live_names)
                    lines.append("ref %s %s" % (a, b))
                elif roll < 0.65:
                    a = rng.choice(live_names)
                    b = rng.choice(live_names)
                    lines.append("unref %s %s" % (a, b))
                elif roll < 0.8:
                    lines.append("pin " + rng.choice(live_names))
                elif roll < 0.95:
                    lines.append("unpin " + rng.choice(live_names))
                else:
                    lines.append("collect")
            with self.subTest(trial=trial):
                self.replay_checked("\n".join(lines) + "\n")


class CycleCollectionTest(unittest.TestCase):
    def test_cycle_invisible_to_refcount(self):
        _, trace, _ = run_script_text(
            "new a\nnew b\nref a b\nref b a\nunpin a\nunpin b\n"
        )
        self.assertNotIn("-a", trace)
        self.assertNotIn("-b", trace)

    def test_collect_reclaims_cycle_sorted(self):
        _, trace, live = run_script_text(
            "new b\nnew a\nref a b\nref b a\nunpin a\nunpin b\ncollect\n"
        )
        self.assertEqual("7 collect -> -a,-b\n", trace.splitlines(keepends=True)[-1])
        self.assertEqual("7 -\n", live.splitlines(keepends=True)[-1])

    def test_reachable_from_root_survives_collect(self):
        _, _, live = run_script_text(
            "new r\nnew c\nref r c\nref c c\nunpin c\ncollect\n"
        )
        self.assertEqual("6 c,r\n", live.splitlines(keepends=True)[-1])

    def test_released_object_fully_detached(self):
        engine = m.Engine()
        events = []
        engine.execute("new", ["a"], events)
        engine.execute("new", ["b"], events)
        engine.execute("ref", ["a", "b"], events)
        engine.execute("unpin", ["b"], events)
        engine.execute("unpin", ["a"], events)
        self.assertEqual({}, engine.objs)
        self.assertEqual({"a", "b"}, engine.used)


def generate_perf_script(path, objects=200_000, ring=4):
    """生成确定性压测脚本：ring 个对象一环，建环、撤外部持有、最后统一 collect。"""
    with open(path, "w", encoding="utf-8", newline="\n") as out:
        names = ["n%06d" % i for i in range(objects)]
        for name in names:
            out.write("new %s\n" % name)
        for base in range(0, objects, ring):
            for k in range(ring):
                out.write("ref %s %s\n" % (names[base + k], names[base + (k + 1) % ring]))
        for name in names:
            out.write("unpin %s\n" % name)
        out.write("collect\n")


class PerformanceTest(unittest.TestCase):
    """预算：50 万级语句、20 万峰值存活，关闭轨迹输出 <= 20 秒。"""

    def test_perf_budget(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            script = os.path.join(tmp, "perf.script")
            generate_perf_script(script)
            with open(script, encoding="utf-8") as generated:
                n_statements = sum(1 for _ in generated)
            self.assertGreaterEqual(n_statements, 500_000)
            start = time.monotonic()
            proc = run_cli([script, "--trace", os.devnull])
            elapsed = time.monotonic() - start
            self.assertEqual(0, proc.returncode)
            self.assertLessEqual(elapsed, 20.0, "耗时 %.1fs 超预算" % elapsed)


class JsEngineTest(unittest.TestCase):
    """页面内嵌引擎（web/engine.js）与期望输出的一致性，经 node 校验。"""

    def setUp(self):
        import shutil

        if shutil.which("node") is None:
            self.skipTest("未安装 node，跳过 JS 引擎校验")

    def test_js_engine_matches_expected(self):
        proc = subprocess.run(
            ["node", str(ROOT / "tests" / "js_check.mjs")],
            capture_output=True,
            text=True,
        )
        self.assertEqual(0, proc.returncode, proc.stderr)

    def test_js_replay_stats_match_expected(self):
        proc = subprocess.run(
            ["node", str(ROOT / "tests" / "js_replay_check.mjs")],
            capture_output=True,
            text=True,
        )
        self.assertEqual(0, proc.returncode, proc.stderr)


if __name__ == "__main__":
    unittest.main()
