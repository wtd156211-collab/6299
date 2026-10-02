// 回放页面逻辑：所有曲线、计数、环统计都来自 engine.js 的确定性回放。
import { Engine, ScriptError, parseScript, replayAll } from "./engine.js";

const SAMPLES = [
  "01_self_loop", "02_mutual_pair", "03_long_cycle", "04_cascade_order",
  "05_churn", "06_temp_burst", "07_after_free_ref", "08_after_free_unref",
  "09_unknown_name", "10_redefine_name", "11_unpin_underflow",
  "12_missing_edge", "13_bad_syntax",
];
const COLORS = ["#d62728", "#1f77b4", "#2ca02c", "#9467bd", "#ff7f0e",
  "#17becf", "#8c564b", "#bcbd22", "#e377c2", "#7f7f7f"];
const TABLE_ROWS = 200;

const $ = (id) => document.getElementById(id);
const sampleSel = $("sample");
for (const name of SAMPLES) {
  const opt = document.createElement("option");
  opt.value = name;
  opt.textContent = name;
  sampleSel.appendChild(opt);
}

let stmts = [];
let record = null;
let engine = new Engine();
let current = 0;
let terminated = false;
let timer = null;

function freshEngine() {
  engine = new Engine();
  current = 0;
  terminated = false;
}

async function loadText(text) {
  stmts = parseScript(text);
  record = replayAll(stmts);
  stopPlay();
  freshEngine();
  $("slider").max = String(record.steps.length);
  renderChart();
  renderCycles();
  renderAll();
}

$("loadSample").addEventListener("click", async () => {
  const name = sampleSel.value;
  const resp = await fetch(`../samples/scripts/${name}.script`);
  if (!resp.ok) {
    alert("加载失败：" + name);
    return;
  }
  await loadText(await resp.text());
});

$("file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (file) await loadText(await file.text());
});

const dropzone = $("dropzone");
window.addEventListener("dragenter", (ev) => { ev.preventDefault(); dropzone.classList.add("over"); });
window.addEventListener("dragover", (ev) => { ev.preventDefault(); });
window.addEventListener("dragleave", () => dropzone.classList.remove("over"));
window.addEventListener("drop", async (ev) => {
  ev.preventDefault();
  dropzone.classList.remove("over");
  const file = ev.dataTransfer.files[0];
  if (file) await loadText(await file.text());
});

// ---- 步进 / 播放 ----
function applyOne() {
  if (terminated || current >= stmts.length) return;
  const s = stmts[current];
  if (s.op === null) {
    terminated = true;
  } else {
    try {
      engine.execute(s.op, s.args, [], s.step);
    } catch (e) {
      if (!(e instanceof ScriptError)) throw e;
      terminated = true;
    }
  }
  current += 1;
}

function seek(k) {
  if (!record) return;
  k = Math.max(0, Math.min(k, record.steps.length));
  stopPlay();
  freshEngine();
  for (let i = 0; i < k; i++) applyOne();
  renderAll();
}

$("next").addEventListener("click", () => { applyOne(); renderAll(); });
$("prev").addEventListener("click", () => { seek(current - 1); });
$("reset").addEventListener("click", () => { seek(0); });
$("slider").addEventListener("change", (ev) => seek(Number(ev.target.value)));

function playTick() {
  const n = Math.max(1, Number($("speed").value) || 1);
  for (let i = 0; i < n; i++) applyOne();
  renderAll();
  if (terminated || current >= record.steps.length) stopPlay();
}
function startPlay() {
  if (timer || !record) return;
  timer = setInterval(playTick, 30);
  $("play").textContent = "暂停";
}
function stopPlay() {
  if (timer) clearInterval(timer);
  timer = null;
  $("play").textContent = "播放";
}
$("play").addEventListener("click", () => (timer ? stopPlay() : startPlay()));

// ---- 渲染 ----
function renderAll() {
  renderStatus();
  renderObjects();
  $("slider").value = String(current);
  $("pos").textContent = `${current}/${record ? record.steps.length : 0}`;
  $("next").disabled = !record || terminated || current >= record.steps.length;
  $("prev").disabled = !record || current === 0;
  drawMarker();
}

function renderStatus() {
  const status = $("status");
  const events = $("events");
  if (!record || current === 0) {
    status.textContent = "当前：尚未执行（步号从 1 起）";
    events.textContent = "";
    return;
  }
  const s = record.steps[current - 1];
  status.textContent = `第 ${s.step} 步：${s.stmt}`;
  events.innerHTML = "";
  if (s.events.length === 0) {
    events.textContent = "事件：-（无创建/释放/错误）";
  } else {
    events.textContent = "事件：";
    for (const ev of s.events) {
      const span = document.createElement("span");
      span.textContent = ev + " ";
      span.className = ev.startsWith("-") ? "free" : ev.startsWith("!") ? "err" : "";
      events.appendChild(span);
    }
  }
}

function renderObjects() {
  const tbody = $("objTable").querySelector("tbody");
  tbody.innerHTML = "";
  const note = $("tableNote");
  if (!record) {
    $("liveCount").textContent = "";
    note.textContent = "";
    return;
  }
  const names = [...engine.objs.keys()].sort();
  $("liveCount").textContent =
    `存活 ${names.length} 个：` + names.slice(0, 300).join(",") +
    (names.length > 300 ? " …" : "");
  const rows = names.slice(0, TABLE_ROWS);
  for (const name of rows) {
    const obj = engine.objs.get(name);
    const tr = document.createElement("tr");
    const outs = [...obj.out.keys()].sort()
      .map((t) => (obj.out.get(t) > 1 ? `${t}×${obj.out.get(t)}` : t))
      .join(", ");
    tr.innerHTML =
      `<td>${name}</td><td>${obj.ext}</td><td>${obj.inc}</td>` +
      `<td>${obj.ext + obj.inc}</td><td>${outs || "-"}</td>`;
    tbody.appendChild(tr);
  }
  note.textContent = names.length > TABLE_ROWS
    ? `表中只列前 ${TABLE_ROWS} 行，共 ${names.length} 个存活对象。`
    : "";
}

function classSeries() {
  const classes = new Set();
  for (const s of record.steps) {
    for (const c of Object.keys(s.classCounts)) classes.add(c);
  }
  return [...classes].sort();
}

function renderChart() {
  const canvas = $("chart");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 900;
  const cssH = 260;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  drawChart(ctx, cssW, cssH, null);
}

function drawMarker() {
  // current 竖线与曲线一起重画（canvas 不能局部擦除）
  const canvas = $("chart");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 900;
  const cssH = 260;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  drawChart(ctx, cssW, cssH, current);
}

function drawChart(ctx, w, h, curStep) {
  const pad = { l: 44, r: 12, t: 10, b: 22 };
  const legend = $("legend");
  legend.innerHTML = "";
  if (!record) return;
  const steps = record.steps;
  const n = steps.length;
  const classes = classSeries();
  let ymax = 1;
  for (const s of steps) {
    for (const c of Object.keys(s.classCounts)) ymax = Math.max(ymax, s.classCounts[c]);
  }
  const xOf = (step) => pad.l + (n <= 1 ? 0 : ((step - 1) / (n - 1)) * (w - pad.l - pad.r));
  const yOf = (v) => h - pad.b - (v / ymax) * (h - pad.t - pad.b);

  ctx.strokeStyle = "#e3e3e3";
  ctx.lineWidth = 1;
  ctx.font = "11px ui-monospace, monospace";
  ctx.fillStyle = "#888";
  for (let g = 0; g <= 4; g++) {
    const v = Math.round((ymax * g) / 4);
    const y = yOf(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(String(v), 6, y + 4);
  }
  ctx.fillText("步", w - pad.r, h - 6);
  ctx.fillText("1", pad.l - 2, h - 6);
  ctx.fillText(String(n), w - pad.r - 8, h - 6);

  classes.forEach((cls, i) => {
    const color = COLORS[i % COLORS.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < n; k++) {
      const v = steps[k].classCounts[cls] || 0;
      const x = xOf(k + 1);
      const y = yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const item = document.createElement("span");
    item.style.color = color;
    item.textContent = cls;
    legend.appendChild(item);
  });

  // 环回收时刻
  for (const e of record.cycleLog) {
    const x = xOf(e.step);
    ctx.strokeStyle = "#b03030";
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#b03030";
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x - 5, pad.t + 7);
    ctx.lineTo(x + 5, pad.t + 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 9px ui-monospace, monospace";
    ctx.fillText(String(e.cycles), x - (e.cycles >= 10 ? 5 : 3), pad.t + 6);
  }

  if (curStep && curStep > 0) {
    const x = xOf(curStep);
    ctx.strokeStyle = "#333";
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function renderCycles() {
  const total = record.cycleLog.reduce((a, e) => a + e.cycles, 0);
  const freed = record.cycleLog.reduce((a, e) => a + e.freed.length, 0);
  $("cycleSummary").textContent =
    `本次回放共在 ${record.cycleLog.length} 次 collect 中释放 ${total} 个环` +
    `（含 ${freed} 个对象）。下图红色虚线即环回收时刻，线上数字为该步回收的环数。`;
  const ul = $("cycles");
  ul.innerHTML = "";
  for (const e of record.cycleLog) {
    const li = document.createElement("li");
    const names = e.freed.slice(0, 40).join(",");
    const more = e.freed.length > 40 ? ` …（共 ${e.freed.length} 个）` : "";
    li.textContent = `第 ${e.step} 步 collect：回收 ${e.cycles} 个环、` +
      `${e.freed.length} 个对象（-${names}${more}）`;
    li.style.cursor = "pointer";
    li.title = "点击跳到该步";
    li.addEventListener("click", () => seek(e.step));
    ul.appendChild(li);
  }
}

const canvas = $("chart");
canvas.addEventListener("click", (ev) => {
  if (!record || record.steps.length === 0) return;
  const rect = canvas.getBoundingClientRect();
  const padL = 44, padR = 12;
  const ratio = (ev.clientX - rect.left - padL) / (rect.width - padL - padR);
  const step = Math.max(1, Math.min(record.steps.length,
    Math.round(1 + ratio * (record.steps.length - 1))));
  seek(step);
});
canvas.addEventListener("mousemove", (ev) => {
  if (!record || record.steps.length === 0) return;
  const rect = canvas.getBoundingClientRect();
  const padL = 44, padR = 12;
  const ratio = (ev.clientX - rect.left - padL) / (rect.width - padL - padR);
  const step = Math.max(1, Math.min(record.steps.length,
    Math.round(1 + ratio * (record.steps.length - 1))));
  const s = record.steps[step - 1];
  const parts = Object.keys(s.classCounts).sort()
    .map((c) => `${c}=${s.classCounts[c]}`).join(" ");
  canvas.title = `第 ${s.step} 步：${s.stmt}\n存活 ${s.live}（${parts || "空"}）`;
});

window.addEventListener("resize", () => { if (record) drawMarker(); });

// 初始自动加载第一个样例
$("loadSample").click();
