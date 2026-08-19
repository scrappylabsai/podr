# podr 🐋

> **herdr herds agents. podr herds whales.**

A [herdr](https://github.com/herdrdev/herdr) fork with the DeepSeek stack wired in as
first-class herd members — because a pod *is* a herd of whales.

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
```

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
