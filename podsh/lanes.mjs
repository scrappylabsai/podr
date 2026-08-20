// Lane awareness for podsh.
//
// A dsh host is a *lane*: one endpoint, one model catalog. You can run several
// at once (one per provider) and they all share ~/.dsh, so sessions are visible
// from every lane while the selected model is a single global setting.
//
// That makes the port the wrong thing to think about. You care which MODEL you
// want; the lane is just where it lives. These helpers let podsh resolve a
// model to the lane that actually serves it.
//
//   PODSH_LANES="127.0.0.1:3080,127.0.0.1:3090"   explicit registry
//   (unset)                                        probe 3080-3099 on loopback

export const DEFAULT_SCAN = Array.from({ length: 20 }, (_, i) => `127.0.0.1:${3080 + i}`);

export function laneList() {
  const env = process.env.PODSH_LANES;
  if (!env) return DEFAULT_SCAN;
  return env.split(",").map((s) => s.trim().replace(/^https?:\/\//, "")).filter(Boolean);
}

async function rpc(host, method, payload = {}, timeoutMs = 2500) {
  const r = await fetch(`http://${host}/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (!j.result?.ok) throw new Error(j.result?.error?.code ?? "rpc-failed");
  return j.result.value;
}

/** Probe every known lane in parallel. Never throws; a dead lane is just up:false. */
export async function probeLanes(hosts = laneList(), { timeoutMs = 2500 } = {}) {
  return Promise.all(hosts.map(async (host) => {
    try {
      const { items } = await rpc(host, "session.list", {}, timeoutMs);
      // The catalog is per-session-shaped, but it describes the HOST's routes.
      let models = [], current = null;
      if (items.length) {
        const v = await rpc(host, "session.models", { sessionId: items[0].sessionId }, timeoutMs);
        models = (v.groups ?? []).flatMap((g) => (g.models ?? []).map((m) => `${g.id}/${m.id}`));
        current = v.current ?? null;
      }
      return { host, up: true, sessions: items.length, models, current };
    } catch {
      return { host, up: false, sessions: 0, models: [], current: null };
    }
  }));
}

/** Match "glm-5.2:cloud" or "deepseek-official/glm-5.2:cloud" against a lane's catalog. */
export function laneServes(lane, model) {
  if (!model) return false;
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return lane.models.some((m) => m === model || m.slice(m.indexOf("/") + 1) === bare);
}

/** Which live lane serves this model? Returns the lane, or null. */
export async function findLaneFor(model, hosts = laneList()) {
  const lanes = (await probeLanes(hosts)).filter((l) => l.up);
  return lanes.find((l) => laneServes(l, model)) ?? null;
}

/** Human-readable lane table for `podsh lanes`. */
export function renderLanes(lanes, { hereHost = null } = {}) {
  const out = [];
  for (const l of lanes) {
    if (!l.up) { out.push(`  ○ ${l.host}  (down)`); continue; }
    const here = l.host === hereHost ? "  ← here" : "";
    const cur = l.current ? `${l.current.model}${l.current.reasoningEffort ? " · " + l.current.reasoningEffort : ""}` : "?";
    out.push(`  ● ${l.host}  serves: ${l.models.map((m) => m.slice(m.indexOf("/") + 1)).join(", ") || "(empty catalog)"}${here}`);
    out.push(`      ${l.sessions} sessions · global model: ${cur}`);
  }
  if (!out.length) out.push("  (no lanes found — set PODSH_LANES, or start one with `podsh web`)");
  return out.join("\n");
}
