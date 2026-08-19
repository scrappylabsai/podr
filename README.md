# podr 🐋

> **herdr herds agents. podr herds whales — and everything else too.**

A [herdr](https://github.com/herdrdev/herdr) fork where the DeepSeek stack is
a first-class herd member — because a pod *is* a herd of whales. Every agent
upstream herdr tracks (claude, codex, gemini, and twenty more) still works
exactly the same; podr just refuses to leave the whale outside.

**Being a dsh'r shouldn't feel second class. It's the King of the Deep.**

If you run **reasonix** (the DeepSeek-native voice agent) you're going to want
**dsh** (the DeepSeek Harness) — and once you run both, you want your terminal
multiplexer to actually *see* them: which pane is working, which one is blocked
on an approval, which one is waiting on you. That's podr.

## What's in the pod

| Piece | What it gives you |
|---|---|
| **herdr fork** | Everything upstream herdr does, plus two extra agents in the detection registry |
| **`Agent::Reasonix`** | reasonix panes tracked with working/blocked states (approval panels, question cards, turn/tool spinners — locale-safe rules) |
| **`Agent::Evolv`** | dsh sessions tracked in the herd via `evolv attach` (below) |
| **`evolv/`** | A terminal face for the dsh web host: `attach` (live tail + drive), `send` (script sessions from any shell), a thin launcher |

## The trick: cooperative agents

Every other agent in a multiplexer's herd is tracked by **screen-scraping** —
hundreds of regex rules over the terminal grid that break whenever the agent's
UI changes.

podr's `evolv` agent inverts that. dsh's client is React-over-a-protocol
(HTTP RPC + a WebSocket event stream), so `evolv attach` is just *another
client* — and since we own it, it **broadcasts its state** instead of being
reverse-engineered:

```
✳ evolv · my session      idle
⠿ evolv · my session      working (turn open)
⏸ evolv · approval        blocked (waiting on you)
```

Three OSC-title rules. No screen matching. It cannot drift, because the client
emits the contract the manifest reads (`src/detect/manifests/evolv.toml`).

## Quickstart

```bash
# 1. Build the fork (needs zig for the vendored terminal core)
ZIG=/path/to/zig LIBGHOSTTY_VT_SIMD=false cargo build --release

# 2. Put evolv on your PATH and point it at your model endpoint
#    (evolv checks for node >= 22.15 — dsh's hard floor — and says so if not)
export PATH="$PWD/evolv:$PATH"
export DEEPSEEK_BASE_URL=http://localhost:8000/v1   # any OpenAI-compatible endpoint
export DEEPSEEK_API_KEY=local

# 3. Run herdr (target/release/herdr), open a pane, and:
evolv attach
```

`evolv attach` finds a running dsh web host (or boots one, or falls back to a
read-only file tail of `~/.dsh/sessions`), tails the most recent session live,
and joins the herd:

- `l` — flip between sessions (no reconnect; the event mux carries them all)
- `m` — **model + thinking-effort picker** (the DeepSeek adapter exposes `off/high/max`)
- `i` — queue a prompt · `s` — **steer into the running turn** · `c` — cancel
- `y` / `n` — answer tool approvals from the pane (the browser stays live too;
  first answer wins, the other face clears)
- `1-9` — answer simple questions · `/…` — host commands (`/permission`, `/plan`, …)

The browser tab and the terminal pane are **two live faces of one session** —
the host fans events out to every connected client and sessions have no owner.

```bash
# script it from anywhere:
evolv send --list
evolv send --session <id> --watch "run the tests and summarize failures"
evolv send --steer "stop — wrong directory, use ./services"
evolv send --models                     # catalog + current selection + routability
evolv send --effort max                 # crank the thinking level, keep the model
evolv send --model deepseek-official/deepseek-v4-pro --effort high
```

### Second lanes (e.g. Ollama Cloud)

One install can serve multiple model lanes. Point `DEEPSEEK_BASE_URL` at the lane
and pass a config overlay for anything the lane needs (model names, token caps):

```bash
export DEEPSEEK_BASE_URL=http://<ollama-host>:11434/v1
export EVOLV_PATCH=$PWD/evolv/examples/ollama-cloud.patch.yml
evolv attach     # spawn-on-demand inherits the overlay
```

See `evolv/examples/ollama-cloud.patch.yml` — it also fixes the trap where
Ollama Cloud rejects dsh's default 256k max-token request with a hard 400.

## Gotchas we hit so you don't

- **First boot is silent and slow.** The first `evolv web` (or the first attach that
  spawns one) installs dsh's web profile — minutes with no output. It's working; wait.
  Never start two first-boots at once (npm's cache lock corrupts: `ECOMPROMISED`).
- **🔴 The version pin only pins half the stack.** `DSH_PIN` pins the *launcher*
  (`@deepseek-ai/dsh` via npx), but the launcher then installs a **profile** whose plugin
  bundles resolve at first-boot time — so they float to whatever is newest then. Measured
  2026-08-19 across two machines with the *same* `DSH_PIN=0.1.0-rc.6`:

  | Host | launcher | profile plugins |
  |---|---|---|
  | installed 2026-08-13 | rc.6 | rc.6 |
  | installed 2026-08-19 | rc.6 | **rc.8** |

  Both worked, but they are not the same install. Check yours with
  `ls ~/.dsh/profiles/*/node_modules/@deepseek-ai/dsh-base/package.json`. If you need
  reproducibility, snapshot `~/.dsh/profiles/` — do not assume the pin did it for you.
- **Effort values are adapter-side, not backend-validated** — and they move with that drift:
  the rc.6 adapter offers `off/high/max`, rc.8 offers `off/low/high/max`. Ollama's own API
  accepts `high/medium/low/none`, so `max` against an Ollama lane is a hard 400. On cloud
  lanes stick to `low`/`high`.
- **Model selection is sticky.** A new session inherits the last selection, which can beat
  your overlay's default — pass `evolv send --model …:cloud --effort high` explicitly when
  lane-hopping.

## Status — read this

- **dsh is pre-1.0 and moving.** Everything here is validated against the
  pinned version in `evolv/evolv` (`DSH_PIN`). Don't float latest; bump the pin
  deliberately and re-test.
- The wire protocol facts the clients rely on were derived from dsh's shipped
  contract layer and verified live; upstream has promised breaking changes.
- Tracks upstream herdr by merge. Same build, same license (Apache-2.0).

## Credits

- [herdr](https://github.com/herdrdev/herdr) — the upstream herd.
- [Ahmed Al Busaidy](https://github.com/ahmedalbusaidy) — the reasonix
  detection integration this fork builds on.
- [DeepSeek](https://github.com/deepseek-ai) — dsh and the whales themselves.
- Upstream herdr README: [README.upstream.md](README.upstream.md).

🐋 *ScrappyLabs — bring your own AI.*
