// 用 node 校验 web/engine.js 与 Python 期望输出逐字节一致。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Engine, parseScript } from "../web/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const scriptsDir = path.join(root, "samples", "scripts");
const expectedDir = path.join(root, "samples", "expected");

function render(statements, recordLive) {
  const engine = new Engine();
  let trace = "";
  let live = "";
  for (const s of statements) {
    const events = [];
    if (s.op === null) {
      events.push("!" + s.error);
    } else {
      try {
        engine.execute(s.op, s.args, events, s.step);
      } catch (e) {
        events.length = 0;
        events.push("!" + e.code);
      }
    }
    trace += `${s.step} ${s.stmt} -> ${events.length ? events.join(",") : "-"}\n`;
    if (recordLive) {
      const names = [...engine.objs.keys()].sort();
      live += `${s.step} ${names.length ? names.join(",") : "-"}\n`;
    }
    if (events.length === 1 && events[0].startsWith("!")) break;
  }
  return { trace, live };
}

let failures = 0;
for (const file of readdirSync(scriptsDir).sort()) {
  if (!file.endsWith(".script")) continue;
  const name = path.basename(file, ".script");
  const text = readFileSync(path.join(scriptsDir, file), "utf8");
  const statements = parseScript(text);
  const { trace, live } = render(statements, true);
  const expTrace = readFileSync(path.join(expectedDir, name + ".trace.txt"), "utf8");
  const expLive = readFileSync(path.join(expectedDir, name + ".live.txt"), "utf8");
  if (trace !== expTrace) {
    console.error("TRACE DIFF", name);
    failures++;
  }
  if (live !== expLive) {
    console.error("LIVE DIFF", name);
    failures++;
  }
}
process.exit(failures === 0 ? 0 : 1);
