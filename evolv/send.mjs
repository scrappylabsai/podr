#!/usr/bin/env node
// evolv send — v0.5 uplink, first slice: prompt a session on the RUNNING dsh
// web host from the CLI (attached or not — sessions have no owner; verified
// live 2026-08-19 against dsh 0.1.0-rc.6). Fire-and-forget: watch the result in
// `evolv attach`, the browser tab, or pass --watch to tail until turn/end.
//
// Usage:
//   evolv send "text"                         queue onto the most recent session
//   evolv send --session <id|short> "text"    target a session
//   evolv send --steer "text"                 inject into the RUNNING turn
//   evolv send --new [--cwd DIR] "text"       create a fresh session first
//   evolv send --cancel [--session <id>]      cancel the active turn
//   evolv send --list                         one-line-per-session inventory
//   any command: [--host 127.0.0.1:3080] [--watch]

const argv = process.argv.slice(2);
const opt = { host: "127.0.0.1:3080", session: null, steer: false, cancel: false, list: false, mknew: false, cwd: null, watch: false, text: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => { const v = argv[++i]; if (v === undefined) { console.error(`evolv send: ${a} needs a value`); process.exit(2); } return v; };
  if (a === "--session") opt.session = next();
  else if (a === "--host") opt.host = next();
  else if (a === "--cwd") opt.cwd = next();
  else if (a === "--steer") opt.steer = true;
  else if (a === "--cancel") opt.cancel = true;
  else if (a === "--list") opt.list = true;
  else if (a === "--new") opt.mknew = true;
  else if (a === "--watch") opt.watch = true;
  else if (a === "--help" || a === "-h") { console.log("evolv send [--session id] [--steer|--cancel|--new|--list] [--cwd DIR] [--watch] \"text\""); process.exit(0); }
  else opt.text.push(a);
}
const TEXT = opt.text.join(" ");
const BASE = `http://${opt.host.replace(/^https?:\/\//, "")}`;
const sanitize = (s) => String(s).replace(/[\x00-\x1f\x7f\x9b]/g, " ");
const short = (sid) => String(sid).replace(/^session-/, "").slice(0, 8);

async function rpc(method, payload = {}) {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload }),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => { console.error(`evolv send: no dsh host at ${BASE} (${e.message}) — start one with \`evolv attach\` or \`evolv web\``); process.exit(1); });
  const j = await r.json();
  if (!j.result?.ok) { console.error(`evolv send: ${method} → ${j.result?.error?.code}: ${j.result?.error?.message ?? ""}`); process.exit(1); }
  return j.result.value;
}

const { items } = await rpc("session.list");

if (opt.list) {
  for (const it of items.slice(0, 20)) {
    const title = sanitize(it?.projections?.values?.title ?? "(untitled)");
    console.log(`${it.running ? "●" : "○"} ${short(it.sessionId)}  ${title}  ${it.cwd ?? ""}`);
  }
  process.exit(0);
}

let sid;
if (opt.mknew) {
  const created = await rpc("session.create", { cwd: opt.cwd ?? process.cwd() });
  sid = created.sessionId;
  console.log(`new session ${short(sid)} (${opt.cwd ?? process.cwd()})`);
} else {
  const m = opt.session
    ? items.find((i) => i.sessionId === opt.session || short(i.sessionId) === opt.session || i.sessionId.includes(opt.session))
    : items[0];
  if (!m) { console.error(`evolv send: session not found: ${opt.session}`); process.exit(1); }
  sid = m.sessionId;
}

if (opt.cancel) {
  await rpc("session.cancel", { sessionId: sid });
  console.log(`cancelled active turn on ${short(sid)} (queued work resumes FIFO)`);
  process.exit(0);
}

if (!TEXT) { console.error("evolv send: nothing to send (pass text, or --cancel/--list)"); process.exit(2); }

if (TEXT.startsWith("/")) {
  // Host command path — session.prompt leaks "/" text to the model on rc.6.
  const v = await rpc("commands/execute", { args: { agentId: sid, line: TEXT } });
  console.log(`(${v?.result?.kind ?? "?"}) ${sanitize(v?.result?.text ?? "")}`);
  process.exit(v?.result?.kind === "error" ? 1 : 0);
}
const mode = opt.steer ? "steer" : "queue";
await rpc("session.prompt", { sessionId: sid, mode, content: [{ type: "text", text: TEXT }] });
console.log(`${mode === "steer" ? "steered into" : "queued to"} ${short(sid)} — watch: evolv attach --session ${short(sid)}`);

if (opt.watch) {
  // minimal tail: follow the mux until this session's turn/end
  const ws = new WebSocket(`ws://${BASE.replace(/^http:\/\//, "")}/api/events.mux`);
  let streamed = false;
  const bail = setTimeout(() => { console.log("(watch timeout 180s — still running; see evolv attach)"); process.exit(0); }, 180000);
  ws.addEventListener("message", (m) => {
    let env; try { env = JSON.parse(m.data); } catch { return; }
    const f = env.payload;
    if (f?.type !== "session/event" || f.sessionId !== sid) return;
    const ev = f.event;
    if (ev?.type === "assistant/chunk" && ev.data?.chunk?.type === "text-delta") { streamed = true; process.stdout.write(sanitize(ev.data.chunk.text)); }
    if (ev?.type === "assistant/message" && !streamed) console.log(sanitize((ev.data?.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n")));
    if (ev?.type === "turn/end") { clearTimeout(bail); console.log(`\n── turn end (${ev.data?.reason?.kind ?? "?"}) ──`); process.exit(0); }
  });
}
