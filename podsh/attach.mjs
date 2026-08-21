#!/usr/bin/env node
// podsh attach — a terminal face for a running dsh web host (the TUI upstream
// never shipped). Live tail, session flip, in-pane uplink (prompt / steer /
// cancel / approvals), and OSC titles so a multiplexer can track the session.
//
// Wire facts (verified live 2026-08-19 against dsh 0.1.0-rc.6):
//   unary RPC  = HTTP POST /api/<dotted.method>  {type:'client-request',rpcId,method,payload}
//   events     = ws /api/events.mux — implicit subscribe-all, DOWNLINK-ONLY
//   frames     = {type:'server-request',rpcId,method,payload:<MuxFrame>}
//   auth       = loopback Host fence only
//
// Usage: podsh attach [--session <id>] [--host HOST:PORT] [--no-spawn] [--plain]
//   default host: $EVOLV_HOST, else 127.0.0.1:3080

import { spawn } from "node:child_process";
import { openSync, closeSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { probeLanes, laneServes, findLaneFor, renderLanes } from "./lanes.mjs";
import { Region, LineEditor, KeyDecoder, SPINNER, visWidth, truncVis, padVis } from "./ui.mjs";

// ---------- args ----------
const argv = process.argv.slice(2);
// PODSH_HOST lets a launcher/pane set the default host (e.g. a second lane on :3081).
const opt = { host: process.env.PODSH_HOST || process.env.EVOLV_HOST || "127.0.0.1:3080", session: null, model: null, spawn: true, plain: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) { console.error(`podsh attach: ${a} needs a value`); process.exit(2); }
    return v;
  };
  if (a === "--session") opt.session = next();
  else if (a.startsWith("--session=")) opt.session = a.slice(10);
  else if (a === "--host") opt.host = next();
  else if (a.startsWith("--host=")) opt.host = a.slice(7);
  else if (a === "--model") opt.model = next();
  else if (a === "--no-spawn") opt.spawn = false;
  else if (a === "--plain") opt.plain = true;
  else if (a === "--help" || a === "-h") {
    console.log(`podsh attach [--session <id>] [--model <id>] [--host HOST:PORT] [--no-spawn] [--plain]
  --model picks the LANE that serves it (see: podsh lanes)
  default host: ${opt.host}${process.env.PODSH_HOST || process.env.EVOLV_HOST ? " (from PODSH_HOST)" : ""}`);
    process.exit(0);
  }
}
opt.host = opt.host.replace(/^https?:\/\//, "");
const BASE = `http://${opt.host}`;
const isTTY = process.stdout.isTTY && process.stdin.isTTY;

// ---------- tiny ANSI kit ----------
const C = opt.plain || !process.stdout.isTTY
  ? new Proxy({}, { get: () => (s) => s })
  : {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      gray: (s) => `\x1b[90m${s}\x1b[0m`,
    };
// Rich mode is the bottom-anchored composer (ui.mjs): the input box is always
// live and the transcript scrolls above it. --plain and non-TTY keep the older
// modal path untouched, so scripts and dumb terminals see what they always saw.
const RICH = isTTY && !opt.plain;
let region = null;   // rich mode only
let editor = null;   // rich mode only
let composeBuf = null; // --plain only: output queues while the modal input line is open
const emit = (s) => {
  if (region) region.write(s);
  else if (composeBuf) composeBuf.push(s);
  else process.stdout.write(s);
};
const out = (s = "") => emit(s + "\n");
// Strip terminal control bytes from UNTRUSTED text (session titles, model output,
// tool names all originate from model/user content). Keeps \n and \t.
const sanitize = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, "");
const sanitizeLine = (s) => String(s).replace(/[\x00-\x1f\x7f\x9b]/g, " ");
const trim1 = (s, n = 2000) => {
  s = sanitize(s);
  return s.length <= n ? s : s.slice(0, n) + C.gray(` … (+${s.length - n} chars)`);
};

// ---------- OSC titles (the podr contract: braille=working, ✳=idle, ⏸=blocked) ----------
let lastTitle = "";
function setTitle(t) {
  if (opt.plain || !process.stdout.isTTY) return;
  t = sanitizeLine(t).slice(0, 120);
  if (t === lastTitle) return;
  lastTitle = t;
  process.stdout.write(`\x1b]0;${t}\x07`);
}

// ---------- RPC ----------
async function rpc(method, payload = {}, { timeoutMs = 10000 } = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${method}`);
  const j = await r.json();
  if (!j.result?.ok) throw new Error(`${method}: ${j.result?.error?.code} ${j.result?.error?.message ?? ""}`);
  return j.result.value;
}

async function hostUp(timeoutMs = 2500) {
  try { await rpc("session.list", {}, { timeoutMs }); return true; } catch { return false; }
}

// ---------- connect-or-spawn-or-file-tail ----------
async function ensureHost() {
  if (await hostUp()) return true;
  const isLoopback = /^(127\.|localhost|\[::1\])/.test(opt.host);
  if (opt.spawn && isLoopback) {
        const port = (opt.host.match(/:(\d+)$/) ?? [])[1] || "3080";
    out(C.yellow(`no dsh host at ${opt.host} — spawning: podsh web --port ${port} (log: /tmp/podsh-web.log)`));
    const logFd = openSync("/tmp/podsh-web.log", "a");
    const podshBin = process.env.PODSH_BIN ?? process.env.EVOLV_BIN ?? new URL("./podsh", import.meta.url).pathname;
    const child = spawn(podshBin, ["web", "--port", port], {
      detached: true, stdio: ["ignore", logFd, logFd],
    });
    child.on("error", (e) => out(C.red(`spawn failed: ${e.message}`))); // wait loop then falls through
    child.unref();
    closeSync(logFd);
    process.stdout.write(C.dim("waiting for host (first boot installs the dsh profile — can take minutes)"));
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (i % 3 === 0) process.stdout.write(C.dim("."));
      if (await hostUp(1500)) { out(C.green(" up")); return true; }
    }
    out(C.red(" gave up after 5 min — check /tmp/podsh-web.log"));
  }
  // Optional read-only fallback: a session-log tailer, if one is installed.
  const tailer = process.env.PODSH_TAILER;
  if (tailer) {
    out(C.yellow(`falling back to read-only file tail (${tailer} --follow)`));
    const t = spawn(tailer, ["--follow"], { stdio: "inherit" });
    t.on("error", (e) => { console.error(`podsh: tailer unavailable: ${e.message}`); process.exit(1); });
    t.on("exit", (code) => process.exit(code ?? 0));
    return false;
  }
  console.error(`podsh: no dsh host at ${opt.host}. Start one with \`podsh web\`, or point at an
existing host with --host / $PODSH_HOST. (Set $PODSH_TAILER to fall back to a
read-only session-log tailer instead.)`);
  process.exit(1);
}

// ---------- session helpers ----------
const titleOf = (item) =>
  item?.projections?.values?.title ?? item?.title ?? "(untitled)";
const shortId = (sid) => String(sid).replace(/^session-/, "").slice(0, 8);

async function pickDefaultSession() {
  const { items } = await rpc("session.list");
  if (!items.length) throw new Error("no sessions on host — start one in the browser first");
  return { sid: items[0].sessionId, items };
}

// ---------- renderer ----------
const st = {
  sid: null,          // attached session id
  turnOpen: false,
  pending: new Map(), // approvalId/questionKey -> label (blocked while non-empty)
  title: "",
  streamedStep: null, // "turn:step" whose chunks we streamed (skip its assistant/message body)
  midStream: false,   // cursor is mid-line inside a streamed chunk
  quitting: false,
};

function refreshTitle() {
  const t = st.title || (st.sid ? shortId(st.sid) : "dsh");
  if (st.pending.size) setTitle(`⏸ dsh · ${[...st.pending.values()][0].kind}`);
  else if (st.turnOpen) setTitle(`⠿ dsh · ${t}`);
  else setTitle(`✳ dsh · ${t}`);
}

function endStream() {
  if (st.midStream) { emit("\n"); st.midStream = false; }
}

// Backend errors are the only place the real vocabulary shows up: dsh's adapter
// validates against ITS list, the backend rejects from its own, and the two can
// have an empty intersection. Turn that into something actionable.
function turnErrorHint(msg) {
  const m = msg.toLowerCase();
  if (m.includes("reasoning")) {
    const list = msg.match(/(?:supported|expected)[^.]*?((?:[`'"]?[a-z]+[`'"]?(?:\s*\(default\))?[,\s]+(?:and\s+)?){1,6})/i);
    const vals = list ? [...new Set((list[1].match(/[a-z]+/gi) || []).filter((v) => v.toLowerCase() !== "default"))] : [];
    return `this backend's effort values${vals.length ? `: ${vals.join(" / ")}` : " differ from the picker's"}` +
           ` — press m to change, or use "off" (portable across backends)`;
  }
  if (m.includes("does not exist") || m.includes("model not found") || m.includes("model-unavailable"))
    return `this session points at a model this host does not serve — press m to pick one from its catalog`;
  if (m.includes("max") && m.includes("token"))
    return `token cap mismatch — set maxTokens in a config overlay (see podsh/examples/)`;
  if (m.includes("context") && m.includes("length"))
    return `context overflow — /compact the session, or lower contextWindow in your overlay`;
  return null;
}

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => (b?.type === "text" ? b.text : b?.type ? C.gray(`[${b.type}]`) : ""))
    .filter(Boolean)
    .join("\n");
}

// One SessionEvent (from history or a mux session/event frame).
// live=false → history replay (skip chunks, print full messages).
function renderEvent(event, view, live) {
  const { type, data } = event ?? {};
  switch (type) {
    case "turn/start":
      st.turnOpen = true;
      endStream();
      out(C.dim(`── turn ${data?.turn} ──`));
      break;
    case "turn/end": {
      st.turnOpen = false;
      endStream();
      const reason = data?.reason;
      const kind = reason?.kind ?? reason ?? "?";
      out(C.dim(`── turn ${data?.turn} end (${kind}) ──`));
      if (kind === "error" && reason?.error) {
        const err = reason.error;
        out(C.red(`✖ ${sanitizeLine(err.message ?? "unknown error")}`) +
            C.gray(`  [${sanitizeLine(String(err.code ?? "?"))}${err.status ? " " + err.status : ""}]`));
        const hint = turnErrorHint(String(err.message ?? ""));
        if (hint) out(C.yellow(`  ↳ ${hint}`));
      }
      break;
    }
    case "step/start":
    case "step/end":
      break; // noise at this zoom level
    case "user/message": {
      endStream();
      const msg = data?.message ?? data;
      const src = msg?.source;
      if (src && src.kind !== "user") {
        // Injected context (runtime snapshots, skills, file notices…) — one dim line.
        const label = src.plugin ?? src.kind;
        const gist = src.summary ?? textOfBlocks(msg?.content).replace(/\s+/g, " ").slice(0, 90);
        out(C.gray(sanitizeLine(`↪ ${label}: ${gist}`)));
      } else {
        out(C.cyan("❯ ") + trim1(textOfBlocks(msg?.content) || C.gray("(no text)")));
      }
      break;
    }
    case "assistant/chunk": {
      if (!live) break; // history renders assembled messages only
      const ch = data?.chunk;
      if (ch?.type === "text-delta") { emit(sanitize(ch.text)); st.midStream = true; }
      st.streamedStep = `${data?.turn}:${data?.step}`;
      break;
    }
    case "assistant/message": {
      const key = `${data?.turn}:${data?.step}`;
      const usage = data?.usage ? C.gray(`  [${data.usage.outputTokens ?? "?"} out]`) : "";
      if (live && st.streamedStep === key) { endStream(); if (usage) out(usage.trimStart()); }
      else { endStream(); const t = textOfBlocks(data?.message?.content); if (t) out(trim1(t) + usage); }
      st.streamedStep = null;
      break;
    }
    case "tool/call": {
      endStream();
      const label = sanitizeLine(view?.title ? view.title : data?.name ?? "?");
      let args = "";
      if (!view?.title && data?.arguments) args = C.gray(" " + trim1(String(data.arguments), 100));
      out(C.dim(`⚙ ${label}`) + args);
      break;
    }
    case "tool/result":
      break; // result cards are browser fare; errors surface via stream/error
    default:
      if (type && !NOISE.has(type)) out(C.gray(`· ${type}`));
  }
}

// Log-only records that add nothing at tail zoom (seen live 2026-08-19).
const NOISE = new Set([
  "agent/inbox/spliced", "request/header", "request/context",
  "session/title-llm-request", "permission/preset", "sandbox/mode",
  "approval/policy", "session/title",
]);

// One MuxFrame from the WS. rpcId is the ENVELOPE id — answerable frames
// (approval/question requested) must echo it verbatim on POST /api/respond.
function handleFrame(f, rpcId) {
  if (!f?.type) return;
  const mine = f.sessionId === st.sid;
  switch (f.type) {
    case "session/event":
      if (mine) renderEvent(f.event, f.view, true);
      if (mine) refreshTitle();
      break;
    case "approval/requested":
      if (mine) {
        endStream();
        st.pending.set(f.approvalId, { kind: "approval", rpcId, approvalId: f.approvalId, toolName: f.toolName });
        out(C.red(C.bold(`⏸ APPROVAL`)) + ` — tool ${C.bold(sanitizeLine(f.toolName ?? "?"))}${f.reason ? C.dim(` (${sanitizeLine(f.reason)})`) : ""} — ${C.bold("y")} allow once · ${C.bold("n")} reject · or answer in the browser`);
        refreshTitle();
      }
      break;
    case "approval/resolved":
      if (mine && st.pending.delete(f.approvalId)) {
        out(C.green(`✔ approval resolved${f.outcome ? ` (${f.outcome})` : ""}`));
        refreshTitle();
      }
      break;
    case "question/requested":
      if (mine) {
        endStream();
        // v0 limitation: one shared key — with 2+ questions outstanding, the first
        // resolved clears the blocked state early (resolved frames mint fresh rpcIds,
        // so per-question matching isn't possible from this frame alone).
        st.pending.set(`q`, { kind: "question", rpcId, questions: f.questions ?? [] });
        const q = (f.questions ?? []).map((x) => x?.question).filter(Boolean).join(" | ");
        out(C.red(C.bold(`⏸ QUESTION`)) + ` — ${trim1(q || "(see browser)", 300)}`);
        refreshTitle();
      }
      break;
    case "question/resolved":
      if (mine && st.pending.delete("q")) { out(C.green("✔ question answered")); refreshTitle(); }
      break;
    case "session/title":
      if (mine && f.title) { st.title = f.title; refreshTitle(); }
      break;
    case "stream/error":
      if (mine) {
        endStream();
        const msg = String(f.message ?? JSON.stringify(f));
        out(C.red(`✖ stream error: ${trim1(msg, 300)}`));
        const hint = turnErrorHint(msg);
        if (hint) out(C.yellow(`  ↳ ${hint}`));
      }
      break;
    // session/subscribed, session/queue, session/jobs, session/projection: quiet at this zoom.
  }
}

// ---------- attach / flip ----------
async function showHeader(item) {
  const title = titleOf(item);
  st.title = typeof title === "string" ? title : "";
  out("");
  out(C.bold(`◍ ${sanitizeLine(st.title || "(untitled)")}`) + C.gray(`  ${shortId(st.sid)}  ${sanitizeLine(item?.cwd ?? "")}`));
  out(C.gray(`  ${item?.running ? "running" : "idle"}${RICH ? " · type to send · / for commands" : " · l sessions · m model · i prompt · s steer · c cancel · q quit"}`));
  st.turnOpen = !!item?.running;
  st.pending.clear();
  refreshTitle();
}

let lastModelLine = "";
async function showModel(sid, { quiet = false } = {}) {
  const v = await rpc("session.models", { sessionId: sid });
  const c = v.current ?? {};
  const catalog = (v.groups ?? []).flatMap((g) => (g.models ?? []).map((m) => m.id));
  const served = catalog.length === 0 || catalog.includes(c.model);
  const line = `${c.provider}/${c.model}${c.reasoningEffort ? " · effort " + c.reasoningEffort : ""}`;
  if (quiet && line === lastModelLine) return;
  lastModelLine = line;
  out((quiet ? C.cyan("↻ model: ") : C.gray("  ")) + C.gray(sanitizeLine(line)) + (served ? "" : C.red("  ⚠ not served here")));
  if (!served) {
    out(C.gray(`  ↳ this lane serves ${catalog.map(sanitizeLine).join(", ")}`));
    findLaneFor(c.model).then((lane) => {
      if (lane) out(C.cyan(`  ↳ ${sanitizeLine(c.model)} lives on ${lane.host} — podsh attach --model ${sanitizeLine(c.model)}`));
      else out(C.yellow(`  ↳ press m to pick one this lane serves`));
    }).catch(() => {});
  } else if (!v.routable) out(C.red("  ⚠ provider route is down on this host — press m"));
}

async function attachTo(sid, items) {
  endStream();
  st.streamedStep = null;
  st.sid = sid;
  const item = (items ?? (await rpc("session.list")).items).find((i) => i.sessionId === sid);
  await showHeader(item);
  try { await showModel(sid); } catch {}
  try {
    const h = await rpc("session.history", { sessionId: sid, maxMessages: 10 });
    for (const e of h.events ?? []) renderEvent(e.event, e.view, false);
    endStream();
    out(C.gray("── live ──"));
  } catch (e) {
    out(C.yellow(`history unavailable: ${e.message}`));
  }
  refreshTitle();
}

// ---------- session picker (raw-mode digits) ----------
let pickerBuf = null; // null = inactive; string = digits so far
let pickerItems = [];
async function openPicker() {
  const { items } = await rpc("session.list");
  pickerItems = items.slice(0, 15);
  endStream();
  out("");
  out(C.bold("─ sessions ─ (number + Enter, Esc cancels)"));
  pickerItems.forEach((it, i) => {
    const dot = it.running ? C.green("●") : C.gray("○");
    const cur = it.sessionId === st.sid ? C.cyan("← here") : "";
    out(` ${String(i + 1).padStart(2)} ${dot} ${trim1(String(titleOf(it)), 60)} ${C.gray(shortId(it.sessionId))} ${C.gray(it.cwd ?? "")} ${cur}`);
  });
  pickerBuf = "";
}

function pickerKey(ch) {
  if (ch === "\x1b") { pickerBuf = null; out(C.gray("(cancelled)")); return; }
  if (ch === "\r" || ch === "\n") {
    if (!region) out(""); // move off the echoed-digits line
    const n = parseInt(pickerBuf, 10);
    pickerBuf = null;
    const it = pickerItems[n - 1];
    if (!it) { out(C.gray("(no such session)")); return; }
    attachTo(it.sessionId).catch((e) => out(C.red(e.message)));
    return;
  }
  if (/[0-9]/.test(ch)) { pickerBuf += ch; if (region) region.schedule(); else process.stdout.write(ch); }
}

// ---------- in-pane input (v0.5 uplink) ----------
let input = null; // { mode: 'queue'|'steer', text }
function openInput(mode) {
  if (!st.sid) return;
  endStream();
  composeBuf = [];
  input = { mode, text: "" };
  process.stdout.write(mode === "steer" ? C.yellow("steer❯ ") : C.cyan("prompt❯ "));
}
function closeInput(send) {
  const { mode, text } = input;
  input = null;
  process.stdout.write("\n");
  const buf = composeBuf;
  composeBuf = null;
  const flush = () => { if (buf.length) process.stdout.write(buf.join("")); };
  if (send && text.trim().startsWith("/")) {
    // Host command — session.prompt does NOT dispatch these on rc.6 (leaks to
    // the model as text, proven live 08-19); commands/execute is the real path.
    rpc("commands/execute", { args: { agentId: st.sid, line: text.trim() } })
      .then((v) => out(C.gray(`(${v?.result?.kind ?? "?"}) ${sanitizeLine(v?.result?.text ?? "")}`)))
      .catch((e) => out(C.red(`command failed: ${e.message}`)))
      .finally(flush);
  } else if (send && text.trim()) {
    rpc("session.prompt", { sessionId: st.sid, mode: mode === "steer" ? "steer" : "queue", content: [{ type: "text", text }] })
      .then(() => out(C.gray(mode === "steer" ? "(steered into running turn)" : "(queued)")))
      .catch((e) => out(C.red(`send failed: ${e.message}`)))
      .finally(flush);
  } else {
    out(C.gray("(input cancelled)"));
    flush();
  }
}
function inputKey(ch) {
  if (ch === "\x1b" || ch === "\x03") return closeInput(false);
  if (ch === "\r" || ch === "\n") return closeInput(true);
  if (ch === "\x7f" || ch === "\b") {
    if (input.text) { input.text = input.text.slice(0, -1); process.stdout.write("\b \b"); }
    return;
  }
  if (ch >= " " || ch === "\t") { input.text += ch; process.stdout.write(ch); }
}
// Answer an answerable server-request: POST /api/respond echoing ITS rpcId.
// Returns the RpcReceipt {accepted, reason?} — accepted:false 'not-pending'
// usually means the browser answered first (both faces stay live by design).
async function respond(rpcId, value) {
  const r = await fetch(`${BASE}/api/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-response", rpcId, result: { ok: true, value } }),
    signal: AbortSignal.timeout(10000),
  });
  return r.json();
}
function firstPending(kind) {
  for (const v of st.pending.values()) if (v.kind === kind) return v;
  return null;
}
function answerApproval(outcome) {
  const p = firstPending("approval");
  if (!p) return;
  respond(p.rpcId, { sessionId: st.sid, approvalId: p.approvalId, outcome })
    .then((rc) => {
      if (rc.accepted) out(C.gray(`(sent: ${outcome === "allowed-once" ? "allow once" : "reject"} — ${sanitizeLine(p.toolName ?? "?")})`));
      else out(C.gray(`(not pending — likely answered in the browser [${rc.reason ?? "?"}])`));
      // the broadcast approval/resolved frame clears the banner for every client
    })
    .catch((e) => out(C.red(`respond failed: ${e.message}`)));
}
function answerQuestion(n) {
  const p = firstPending("question");
  if (!p) return false;
  const q = p.questions[0];
  if (p.questions.length !== 1 || q?.multiSelect || !q?.options?.length) return false;
  const o = q.options[n - 1];
  if (!o) { out(C.gray("(no such option)")); return true; }
  respond(p.rpcId, { sessionId: st.sid, answer: { answers: [{ id: q.id, selected: [o.label] }] } })
    .then((rc) => {
      if (rc.accepted) out(C.gray(`(answered: ${sanitizeLine(o.label)})`));
      else out(C.gray(`(not pending — likely answered in the browser [${rc.reason ?? "?"}])`));
    })
    .catch((e) => out(C.red(`respond failed: ${e.message}`)));
  return true;
}

// ---------- model + effort picker (session.selectModel) ----------
let mp = null; // {stage:'model'|'effort', buf, models, chosen}
async function openModelPicker() {
  if (!st.sid) return;
  const v = await rpc("session.models", { sessionId: st.sid });
  endStream();
  const cur = v.current ?? {};
  out("");
  out(C.bold("─ models ─") + C.gray(` current: ${sanitizeLine(`${cur.provider}/${cur.model}`)}${cur.reasoningEffort ? " · " + sanitizeLine(cur.reasoningEffort) : ""}`) + (v.routable ? "" : C.red(" · NOT ROUTABLE")));
  const flat = [];
  for (const g of v.groups ?? []) for (const m of g.models ?? []) flat.push({ provider: g.id, model: m.id, efforts: m.reasoning?.efforts ?? [] });
  for (const f of v.failures ?? []) out(C.yellow(`  (catalog failure: ${sanitizeLine(f.id)})`));
  if (!flat.length) { out(C.yellow("empty catalog — a serving route can still work: podsh send --model <provider/model>")); return; }
  flat.slice(0, 15).forEach((m, i) =>
    out(` ${String(i + 1).padStart(2)} ${sanitizeLine(`${m.provider}/`)}${C.bold(sanitizeLine(m.model))}${m.efforts.length ? C.gray(` (efforts: ${m.efforts.map((e) => sanitizeLine(e.id)).join("/")})`) : ""}${m.provider === cur.provider && m.model === cur.model ? C.cyan(" ← current") : ""}`));
  out(C.gray("  number + Enter · Esc cancels"));
  mp = { stage: "model", buf: "", models: flat.slice(0, 15), chosen: null };
}
function applyModel(m, effort) {
  const payload = { sessionId: st.sid, provider: m.provider, model: m.model };
  if (effort) payload.reasoningEffort = effort;
  mp = null;
  rpc("session.selectModel", payload)
    .then((v) => { const sl = v.selected ?? payload; out(C.green(`✔ ${sanitizeLine(`${sl.provider}/${sl.model}`)}${sl.reasoningEffort ? " · effort " + sanitizeLine(sl.reasoningEffort) : ""}`)); })
    .catch((e) => out(C.red(`selectModel failed: ${e.message}`)));
}
function mpKey(ch) {
  if (ch === "\x1b" || ch === "\x03") { mp = null; out(C.gray("(cancelled)")); return; }
  if (ch === "\r" || ch === "\n") {
    out("");
    const n = parseInt(mp.buf, 10);
    mp.buf = "";
    if (mp.stage === "model") {
      const m = mp.models[n - 1];
      if (!m) { mp = null; out(C.gray("(no such model)")); return; }
      if (m.efforts.length) {
        mp.chosen = m;
        mp.stage = "effort";
        m.efforts.slice(0, 9).forEach((e, i) => out(` ${i + 1} ${sanitizeLine(e.id)}${e.name && e.name !== e.id ? C.gray(" " + sanitizeLine(e.name)) : ""}`));
        out(C.gray("  effort number + Enter · Enter alone keeps adapter default"));
        return;
      }
      return applyModel(m, undefined);
    }
    const e = Number.isNaN(n) ? undefined : mp.chosen.efforts[n - 1]?.id;
    return applyModel(mp.chosen, e);
  }
  if (/[0-9]/.test(ch)) { mp.buf += ch; if (region) region.schedule(); else process.stdout.write(ch); }
}

function cancelTurn() {
  if (!st.sid) return;
  rpc("session.cancel", { sessionId: st.sid })
    .then(() => out(C.yellow("✋ cancelled active turn (queued work resumes FIFO)")))
    .catch((e) => out(C.red(`cancel failed: ${e.message}`)));
}

// ---------- composer (rich mode) ----------
// One always-live input box pinned to the bottom, transcript scrolling above
// it — the shape people already know from Claude Code / Kimi. The modal `i`/`s`
// path below is kept for --plain and non-TTY.

const HIST_DIR = `${homedir()}/.podsh`;
const HIST_FILE = `${HIST_DIR}/history`;
function loadHistory() {
  try {
    return readFileSync(HIST_FILE, "utf8").split("\n").filter(Boolean)
      .map((l) => l.replace(/\\n/g, "\n")).slice(-500);
  } catch { return []; }
}
function saveHistory(line) {
  try {
    mkdirSync(HIST_DIR, { recursive: true });
    appendFileSync(HIST_FILE, line.replace(/\n/g, "\\n") + "\n");
  } catch { /* history is a convenience, never a reason to fail a send */ }
}

// An approval owns the keyboard while it is pending; a question only does when
// it is answerable from a pane (one question, single-select, real options) —
// otherwise the browser has to take it and typing should keep working.
function pendingPanel() {
  const ap = firstPending("approval");
  if (ap) return { kind: "approval", ap };
  const qn = firstPending("question");
  if (qn) {
    const q = qn.questions?.[0];
    return { kind: "question", qn, q, answerable: qn.questions?.length === 1 && !q?.multiSelect && !!q?.options?.length };
  }
  return null;
}

let spinI = 0;
let lastCtrlC = 0;
function statusRight() {
  const state = st.pending.size ? C.red("blocked")
    : st.turnOpen ? C.yellow(`${SPINNER[spinI % SPINNER.length]} working`)
    : C.green("idle");
  // provider prefixes are the same on every row of a lane's catalog — the model
  // and the effort are what actually change under you.
  const m = lastModelLine ? lastModelLine.slice(lastModelLine.indexOf("/") + 1) : "";
  return state + (m ? C.gray(" · " + truncVis(m, 34)) : "");
}
// The right side (what the session is doing) outranks the key hints: truncate
// the hints, never the state.
function hintRow(cols, left) {
  const r = statusRight() + " ";
  const rw = visWidth(r);
  if (cols - rw < 14) return " ".repeat(Math.max(0, cols - rw)) + r;
  const l = truncVis("  " + left, cols - rw - 1);
  return C.gray(l) + " ".repeat(Math.max(1, cols - visWidth(l) - rw)) + r;
}

function regionLines(cols) {
  const inner = Math.max(4, cols - 4);
  const bar = (a, b, col) => col(a + "─".repeat(Math.max(0, cols - 2)) + b);

  const p = pendingPanel();
  if (p && (p.kind === "approval" || p.answerable)) {
    const lines = [bar("╭", "╮", C.red)];
    const row = (t) => lines.push(C.red("│ ") + padVis(t, inner) + C.red(" │"));
    if (p.kind === "approval") {
      row(C.bold("⏸ approval") + C.gray("  tool ") + C.bold(sanitizeLine(p.ap.toolName ?? "?")));
      row("");
      row(C.green(" 1") + " allow once");
      row(C.red(" 2") + " reject");
      lines.push(bar("╰", "╯", C.red));
      lines.push(hintRow(cols, "y/1 allow · n/2 reject · the browser tab can answer too"));
    } else {
      row(C.bold("⏸ question") + C.gray("  " + truncVis(sanitizeLine(p.q?.question ?? ""), Math.max(4, inner - 14))));
      row("");
      for (const [i, o] of (p.q.options ?? []).slice(0, 9).entries())
        row(C.cyan(` ${i + 1}`) + " " + truncVis(sanitizeLine(o?.label ?? String(o)), Math.max(4, inner - 4)));
      lines.push(bar("╰", "╯", C.red));
      lines.push(hintRow(cols, "1-9 answers · or answer in the browser tab"));
    }
    return { lines };
  }

  if (mp || pickerBuf !== null) {
    const label = mp ? (mp.stage === "effort" ? "effort" : "model") : "session";
    const buf = mp ? mp.buf : pickerBuf;
    const pre = `  ${label} (from the list above) `;
    return {
      lines: [C.gray("  ") + C.bold(label) + C.gray(" (from the list above) ") + C.cyan("❯ ") + buf,
              hintRow(cols, "number + enter · esc cancels")],
      cursor: { row: 0, col: visWidth(pre) + 2 + visWidth(buf) },
    };
  }

  const glyph = st.turnOpen ? C.yellow("⇢") : C.cyan("❯");
  const r = editor.render(inner, glyph + " ", "  ");
  const lines = [bar("╭", "╮", C.gray)];
  for (const l of r.lines) lines.push(C.gray("│ ") + padVis(l, inner) + C.gray(" │"));
  lines.push(bar("╰", "╯", C.gray));
  lines.push(hintRow(cols, st.turnOpen
    ? "enter steers into the running turn · /queue to line it up · esc interrupts"
    : "/ commands · ↑ history · \\ + enter new line · ctrl+c ×2 quit"));
  return { lines, cursor: { row: r.cursor.row + 1, col: r.cursor.col + 2 } };
}

const LOCAL_CMDS = {
  help: "this list",
  sessions: "pick a session on this host",
  model: "pick model + thinking effort",
  lanes: "which dsh hosts are up, and what each serves",
  queue: "/queue <text> — line it up instead of steering the running turn",
  cancel: "cancel the running turn",
  clear: "clear the screen",
  quit: "leave the pane (the session keeps running)",
};

function localHelp() {
  out("");
  out(C.bold("─ podsh ─"));
  out(C.gray("  just type · enter sends · \\ + enter (or alt+enter) for a new line"));
  out(C.gray("  ↑/↓ history · ctrl+a/e home/end · ctrl+w/u/k delete · ctrl+l clear"));
  out(C.gray("  esc interrupts a running turn (clears the box first) · ctrl+c ×2 quits"));
  for (const [k, v] of Object.entries(LOCAL_CMDS)) out("  " + padVis(C.cyan("/" + k), 12) + C.gray(v));
  out(C.gray("  any other /command goes to the host (compact · plan · permission · goal · export · feedback)"));
}

async function showLanes() {
  out(C.gray("scanning lanes…"));
  try { out(renderLanes(await probeLanes(), { hereHost: opt.host })); }
  catch (e) { out(C.red(`lanes failed: ${e.message}`)); }
}

function submitText(text, mode) {
  const t = text.trim();
  if (!t) return;
  if (t.startsWith("/")) {
    const sp = t.indexOf(" ");
    const word = (sp === -1 ? t.slice(1) : t.slice(1, sp)).toLowerCase();
    const arg = sp === -1 ? "" : t.slice(sp + 1).trim();
    switch (word) {
      case "help": case "?": return localHelp();
      case "session": case "sessions": openPicker().catch((e) => out(C.red(e.message))); return;
      case "model": case "models": openModelPicker().catch((e) => out(C.red(e.message))); return;
      case "lanes": showLanes(); return;
      case "cancel": case "stop": return cancelTurn();
      case "clear": return region ? region.clearScreen() : undefined;
      case "quit": case "exit": return quit(0);
      case "queue": return arg ? submitText(arg, "queue") : out(C.gray("(/queue <text>)"));
    }
    // Anything else is the host's: session.prompt does NOT dispatch commands on
    // rc.6 (it leaks them to the model as text) — commands/execute is the path.
    out(C.cyan("/" + word) + (arg ? C.gray(" " + sanitizeLine(arg)) : ""));
    rpc("commands/execute", { args: { agentId: st.sid, line: t } })
      .then((v) => out(C.gray(`(${v?.result?.kind ?? "ok"}) ${sanitizeLine(v?.result?.text ?? "")}`)))
      .catch((e) => out(C.red(`command failed: ${e.message}`)));
    return;
  }
  rpc("session.prompt", { sessionId: st.sid, mode: mode === "steer" ? "steer" : "queue", content: [{ type: "text", text: t }] })
    .then(() => out(C.gray(mode === "steer" ? "(steered into running turn)" : "(queued)")))
    .catch((e) => out(C.red(`send failed: ${e.message}`)));
}

// Pickers predate the composer and speak single characters; keep them.
const asChar = (k) =>
  k.name === "char" ? k.text
  : k.name === "enter" ? "\r"
  : (k.name === "escape" || (k.ctrl && k.name === "c")) ? "\x1b"
  : null;

function routeKey(k) {
  if (mp) { const ch = asChar(k); if (ch) mpKey(ch); return; }
  if (pickerBuf !== null) { const ch = asChar(k); if (ch) pickerKey(ch); return; }

  const p = pendingPanel();
  if (p && (p.kind === "approval" || p.answerable)) {
    if (k.ctrl && k.name === "c") return quit(0);
    if (k.name !== "char") return;
    if (p.kind === "approval") {
      if (k.text === "y" || k.text === "1") return answerApproval("allowed-once");
      if (k.text === "n" || k.text === "2") return answerApproval("rejected");
      return;
    }
    if (/[1-9]/.test(k.text)) answerQuestion(parseInt(k.text, 10));
    return;
  }

  const action = editor.handle(k);
  if (!action) return;
  if (action === "submit") {
    const t = editor.value();
    editor.remember(t);
    if (t.trim()) saveHistory(t);
    editor.clear();
    return submitText(t, st.turnOpen ? "steer" : "queue");
  }
  if (action === "escape") {
    if (editor.value()) return editor.clear();
    if (st.turnOpen) return cancelTurn();
    return;
  }
  if (action === "interrupt") {
    if (editor.value()) { editor.clear(); lastCtrlC = 0; return; }
    const now = Date.now();
    if (now - lastCtrlC < 2000) return quit(0);
    lastCtrlC = now;
    out(C.gray("(ctrl+c again to quit — the session keeps running)"));
    return;
  }
  if (action === "eof") return quit(0);
  if (action === "clear-screen" && region) return region.clearScreen();
}

const dec = new KeyDecoder();
let escTimer = null;
function richKeys(chunk) {
  if (escTimer) { clearTimeout(escTimer); escTimer = null; }
  for (const k of dec.push(chunk)) routeKey(k);
  // A lone ESC is only distinguishable from the start of a sequence by silence.
  if (dec.pendingEscape())
    escTimer = setTimeout(() => {
      escTimer = null;
      const k = dec.flushEscape();
      if (k) { routeKey(k); region?.schedule(); }
    }, 50);
  region?.schedule();
}

function plainKeys(chunk) {
  for (const ch of chunk) { // raw-mode chunks can carry pastes like "12\r"
    if (input) { inputKey(ch); continue; }
    if (mp) { mpKey(ch); continue; }
    if (pickerBuf !== null) { pickerKey(ch); continue; }
    if (ch === "q" || ch === "\x03") return quit(0);
    if (ch === "l") openPicker().catch((e) => out(C.red(e.message)));
    else if (ch === "i") openInput("queue");
    else if (ch === "s") openInput("steer");
    else if (ch === "c") cancelTurn();
    else if (ch === "m") openModelPicker().catch((e) => out(C.red(e.message)));
    else if (ch === "y") answerApproval("allowed-once");
    else if (ch === "n") answerApproval("rejected");
    else if (/[1-9]/.test(ch)) answerQuestion(parseInt(ch, 10));
  }
}

function startComposer() {
  editor = new LineEditor({ history: loadHistory() });
  region = new Region({ stream: process.stdout });
  region.start(regionLines);
  // A resize reflows rows we no longer know the geometry of: forget the old
  // region rather than erase the wrong number of lines out of the scrollback.
  process.stdout.on("resize", () => { region.rows = 0; region.render(); });
  setInterval(() => { if (st.turnOpen) { spinI++; region?.schedule(); } }, 120).unref();
}

// ---------- main ----------
async function main() {
  if (opt.model) {
    const lane = await findLaneFor(opt.model);
    if (!lane) {
      console.error(`podsh: no live lane serves "${opt.model}" — see \`podsh lanes\``);
      process.exit(1);
    }
    if (lane.host !== opt.host) out(C.gray(`${opt.model} lives on ${lane.host} — attaching there`));
    opt.host = lane.host;
  }
  if (!(await ensureHost())) return; // file-tail took over
  const { sid: defSid, items } = await pickDefaultSession();
  const sid = opt.session
    ? (items.find((i) => i.sessionId === opt.session || shortId(i.sessionId) === opt.session)?.sessionId ??
       (() => { throw new Error(`session not found: ${opt.session}`); })())
    : defSid;

  const runningN = items.filter((i) => i.running).length;
  out(C.gray(`podsh attach · host ${opt.host} · ${items.length} sessions${runningN ? ` (${runningN} running)` : ""}`));
  out(RICH
    ? C.gray(`just type · enter sends (steers into a running turn) · alt+enter queues instead · / commands · ↑ history · esc interrupt · ctrl+c ×2 quit`)
    : C.gray(`keys: l sessions · m model/effort · i prompt · s steer(into running turn) · c cancel turn · y/n approvals · 1-9 questions · q quit · "/"=host cmd`));
  await attachTo(sid, items);

  // keys
  if (RICH) startComposer();
  if (isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", RICH ? richKeys : plainKeys);
  }

  // event stream with reconnect
  let retries = 0, stableTimer = null;
  const connectWs = () => {
    const ws = new WebSocket(`ws://${opt.host}/api/events.mux`);
    ws.addEventListener("open", () => {
      // only forgive retries once the link has held for 5s (else flap defeats the cap)
      stableTimer = setTimeout(() => { retries = 0; }, 5000);
    });
    ws.addEventListener("message", (m) => {
      let env; try { env = JSON.parse(m.data); } catch { return; }
      try { handleFrame(env.payload, env.rpcId); } catch (e) { out(C.red(`render error: ${e.message}`)); }
    });
    ws.addEventListener("close", async () => {
      clearTimeout(stableTimer);
      if (st.quitting) return;
      endStream();
      if (++retries > 20) { out(C.red("host gone (20 retries) — exiting")); return quit(1); }
      if (retries === 1) out(C.yellow("connection lost — reconnecting…"));
      setTimeout(async () => {
        if (await hostUp(1500)) { out(C.green("reconnected") + C.gray(" (gap possible — press l to re-pick/refresh)")); }
        connectWs();
      }, 3000);
    });
    ws.addEventListener("error", () => {}); // close handler owns retry
  };
  connectWs();

  // The selected model is a global settings DOCUMENT, not session state: changing
  // it (here, in the browser, or on another lane) fires settings/document-updated
  // on the host stream. Without this the pane's model line silently goes stale.
  const connectHostWs = () => {
    const hws = new WebSocket(`ws://${opt.host}/api/events.host`);
    hws.addEventListener("message", (m) => {
      let env; try { env = JSON.parse(m.data); } catch { return; }
      const f = env.payload;
      if (f?.type === "host/remote-event" && f.event === "settings/document-updated" && st.sid) {
        showModel(st.sid, { quiet: true }).catch(() => {});
      }
    });
    hws.addEventListener("close", () => {
      if (!st.quitting) setTimeout(connectHostWs, 5000);
    });
    hws.addEventListener("error", () => {});
  };
  connectHostWs();
}

function quit(code) {
  st.quitting = true;
  endStream();
  setTitle("✳ dsh · bye");
  if (region) { region.stop(); region = null; }
  if (isTTY) process.stdin.setRawMode(false);
  process.exit(code);
}
process.on("SIGINT", () => quit(0));
process.on("SIGTERM", () => quit(0));

main().catch((e) => { console.error(C.red(`podsh attach: ${e.message}`)); process.exit(1); });
