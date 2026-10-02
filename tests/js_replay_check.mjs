// 校验 web/engine.js 的 replayAll：事件、存活数、分类计数、环回收清单。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseScript, replayAll, classOf } from "../web/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const scriptsDir = path.join(root, "samples", "scripts");
const expectedDir = path.join(root, "samples", "expected");

let failures = 0;
function fail(msg) { console.error("FAIL", msg); failures++; }

for (const file of readdirSync(scriptsDir).sort()) {
  if (!file.endsWith(".script")) continue;
  const name = path.basename(file, ".script");
  const text = readFileSync(path.join(scriptsDir, file), "utf8");
  const record = replayAll(parseScript(text));
  const traceLines = readFileSync(
    path.join(expectedDir, name + ".trace.txt"), "utf8").trimEnd().split("\n");
  const liveLines = readFileSync(
    path.join(expectedDir, name + ".live.txt"), "utf8").trimEnd().split("\n");
  if (record.steps.length !== traceLines.length) {
    fail(`${name}: 步数不一致 ${record.steps.length} != ${traceLines.length}`);
    continue;
  }
  for (let i = 0; i < traceLines.length; i++) {
    const s = record.steps[i];
    const expectEvents = traceLines[i].split(" -> ")[1];
    const gotEvents = s.events.length ? s.events.join(",") : "-";
    if (gotEvents !== expectEvents) {
      fail(`${name} 第${s.step}步 事件 ${gotEvents} != ${expectEvents}`);
    }
    const liveNames = liveLines[i].split(" ").slice(1).join(" ");
    const liveCount = liveNames === "-" ? 0 : liveNames.split(",").length;
    if (s.live !== liveCount) {
      fail(`${name} 第${s.step}步 存活数 ${s.live} != ${liveCount}`);
    }
    // 分类计数与 live 名单重算结果一致
    const counts = Object.create(null);
    if (liveNames !== "-") {
      for (const nm of liveNames.split(",")) {
        const c = classOf(nm);
        counts[c] = (counts[c] || 0) + 1;
      }
    }
    const a = JSON.stringify(Object.keys(counts).sort().map((k) => [k, counts[k]]));
    const b = JSON.stringify(Object.keys(s.classCounts).sort().map((k) => [k, s.classCounts[k]]));
    if (a !== b) fail(`${name} 第${s.step}步 分类计数不一致 ${b} != ${a}`);
  }
  // 环清单与 trace 中的 collect 释放事件互相印证
  const collectFrees = traceLines
    .filter((l) => /collect -> -[a-z]/.test(l))
    .map((l) => l.split(" -> ")[1].split(",").map((e) => e.slice(1)));
  if (collectFrees.length !== record.cycleLog.length) {
    fail(`${name}: cycleLog 条数 ${record.cycleLog.length} != ${collectFrees.length}`);
  }
  for (let i = 0; i < collectFrees.length; i++) {
    const got = record.cycleLog[i].freed.join(",");
    const want = collectFrees[i].join(",");
    if (got !== want) fail(`${name}: 第${i}次环回收对象 ${got} != ${want}`);
    if (record.cycleLog[i].cycles < 1) fail(`${name}: 环数必须 >= 1`);
  }
}
process.exit(failures === 0 ? 0 : 1);
