# podr 🐋

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

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
| **`Agent::Dsh`** | dsh sessions tracked in the herd via `podsh attach` (below) |
| **`podsh/`** | A terminal face for the dsh web host: `attach` (live tail + drive), `send` (script sessions from any shell), a thin launcher |

## The trick: cooperative agents

Every other agent in a multiplexer's herd is tracked by **screen-scraping** —
hundreds of regex rules over the terminal grid that break whenever the agent's
UI changes.

podr's `dsh` agent inverts that. dsh's client is React-over-a-protocol
(HTTP RPC + a WebSocket event stream), so `podsh attach` is just *another
client* — and since we own it, it **broadcasts its state** instead of being
reverse-engineered:

```
✳ dsh · my session      idle
⠿ dsh · my session      working (turn open)
⏸ dsh · approval        blocked (waiting on you)
```

Three OSC-title rules. No screen matching. It cannot drift, because the client
emits the contract the manifest reads (`src/detect/manifests/dsh.toml`).

## Quickstart

```bash
# 1. Build the fork (needs zig for the vendored terminal core)
ZIG=/path/to/zig LIBGHOSTTY_VT_SIMD=false cargo build --release

# 2. Put podsh on your PATH and point it at your model endpoint
#    (podsh checks for node >= 22.15 — dsh's hard floor — and says so if not)
export PATH="$PWD/podsh:$PATH"
export DEEPSEEK_BASE_URL=http://localhost:8000/v1   # any OpenAI-compatible endpoint
export DEEPSEEK_API_KEY=local

# 3. Launch it — ./podr runs the fork in its own named herdr session with
#    podsh already on PATH, then open a pane and:
./podr
podsh attach
```

`./podr` keeps its socket and state separate from any herdr you already run, so
you can try the fork without disturbing your setup. Point it at a lane with
`PODSH_HOST` / `DEEPSEEK_BASE_URL` / `PODSH_PATCH`.

`podsh attach` finds a running dsh web host (or boots one, or falls back to a
read-only file tail of `~/.dsh/sessions`), tails the most recent session live,
and joins the herd.

It has the shape you already know from every other agent CLI: an input box
pinned to the bottom, transcript scrolling above it. **Just type** — there is no
mode to enter first.

```
╭────────────────────────────────────────────────────────────────╮
│ ❯ run the tests and summarize the failures                     │
╰────────────────────────────────────────────────────────────────╯
  / commands · ↑ history · \ + enter new line   ⠹ working · deepseek-v4-flash · effort high
```

- **enter** sends. While a turn is running it **steers into it** instead;
  `/queue <text>` lines the text up for afterwards. `\` + enter (or alt+enter)
  starts a new line.
- **esc** interrupts the running turn — it clears the box first if you typed
  something. **ctrl+c** twice leaves the pane; the session keeps running.
- **↑/↓** walks history (kept in `~/.podsh/history`), and the readline keys work:
  ctrl+a/e, ctrl+w/u/k, alt+←/→, ctrl+l to clear.
- **approvals and questions take the keyboard** while they are pending — `y`/`1`
  allow once, `n`/`2` reject, `1-9` answer a question. The browser tab stays live
  too: first answer wins and the other face clears.
- **`/` commands**: `/sessions` flips between sessions (no reconnect — the event
  mux carries them all), `/model` is the **model + thinking-effort picker** (the
  DeepSeek adapter exposes `off/high/max`), plus `/lanes`, `/cancel`, `/clear`,
  `/help`. Anything else is handed to the host: `/compact`, `/plan`,
  `/permission`, `/goal`, `/export`, `/feedback`.
- **`--plain`** keeps the older modal keys (`l` `m` `i` `s` `c` · `y`/`n` · `1-9`)
  for terminals that can't take the composer; piping the output is unchanged.

The browser tab and the terminal pane are **two live faces of one session** —
the host fans events out to every connected client and sessions have no owner.

```bash
# script it from anywhere:
podsh send --list
podsh send --session <id> --watch "run the tests and summarize failures"
podsh send --steer "stop — wrong directory, use ./services"
podsh send --models                     # catalog + current selection + routability
podsh send --effort max                 # crank the thinking level, keep the model
podsh send --model deepseek-official/deepseek-v4-pro --effort high
```

### Lanes: one host per provider

A dsh host *is* a lane — one endpoint, one model catalog. Run several at once
(one per provider) and podsh will resolve a model to the lane that serves it, so
you pick the model rather than remembering a port:

```bash
podsh lanes                          # what is up, and what each one serves
podsh attach --model glm-5.2:cloud   # attaches to whichever lane has it
podsh send   --model qwen3.8-27b …   # routes there automatically
```

```
lanes (scanned 127.0.0.1:3080-3099):
  ● 127.0.0.1:3080  serves: deepseek-v4-flash, deepseek-v4-pro
      85 sessions · global model: glm-5.2:cloud · high
  ● 127.0.0.1:3090  serves: qwen3.8-27b
  ● 127.0.0.1:3091  serves: glm-5.2:cloud
```

Set `PODSH_LANES="host:port,host:port"` to name them explicitly instead of scanning.

**Changing the model is a global event, not a session one.** The selection lives in
`~/.dsh/settings.yaml` as a versioned settings *document*; changing it anywhere fires
`settings/document-updated` on `/api/events.host`, and clients refetch. So a flip in the
browser shows up in the pane and vice versa — but it also changes the default for every
session on every lane. And nothing validates the choice against the host you are on:
selecting a model this lane cannot serve is *accepted*, stays `routable: true`, and fails
as a 404 on the next turn. podsh surfaces that error and names the lane that has the model.

**Know this about multi-lane setups:** every host shares `~/.dsh`, so sessions are
visible from all of them — but the selected model is a *single global setting* in
`~/.dsh/settings.yaml`, and `selectModel` writes to it. Selecting a model on one
lane becomes the default for **new sessions on every lane**, including ones that
cannot serve it (and `routable` stays `true`, because the provider route is fine —
it is the model that is absent). That is why `podsh lanes` prints the global model
on every row, and why attach tells you where a mismatched model actually lives.

### Second lanes (e.g. Ollama Cloud)

One install can serve multiple model lanes. Point `DEEPSEEK_BASE_URL` at the lane
and pass a config overlay for anything the lane needs (model names, token caps):

```bash
export DEEPSEEK_BASE_URL=http://<ollama-host>:11434/v1
export PODSH_PATCH=$PWD/podsh/examples/ollama-cloud.patch.yml
podsh attach     # spawn-on-demand inherits the overlay
```

See `podsh/examples/ollama-cloud.patch.yml` — it also fixes the trap where
Ollama Cloud rejects dsh's default 256k max-token request with a hard 400.

### One host, many models

A dsh host is one *endpoint* — the llm-deepseek plugin registers the fixed provider
route `deepseek-official`, so you cannot mount it twice with different `baseURL`s.
But one endpoint can front many models. Point a host at Ollama and declare a catalog
and the web UI's picker shows them all:

```bash
export DEEPSEEK_BASE_URL=http://127.0.0.1:11434/v1
export PODSH_PATCH=$PWD/podsh/examples/ollama-everything.patch.yml
podsh web --port 3092          # picker now offers DeepSeek, GLM, Qwen, MiniMax, …
```

**🔴 dsh's default catalog is advisory, not real.** With no overlay it advertises
`deepseek-v4-flash` *and* `deepseek-v4-pro` no matter what your endpoint serves — so
against a vLLM hosting only Flash, Pro looks selectable and 404s at turn time. Declare
what your endpoint actually has (`podsh/examples/sparks-vllm.patch.yml` is the
one-model case).

**🔴 On Ollama, `ollama pull` every cloud model you list.** The web UI filters your
declared catalog against what the endpoint actually *lists*, and Ollama runs `:cloud`
models on demand without listing them until they are registered. So an unregistered
cloud model works fine through the API and is **invisible in the browser's picker**:

```bash
ollama pull glm-5.2:cloud      # manifest only — no weights, instant, no disk
```

(Registering is not downloading: a cloud pull writes a manifest and the model still
runs remotely.)

**Name the locality.** The picker shows only the display *name*, so a model served
from your own GPU and the same model served from a cloud endpoint are
indistinguishable — which matters a lot when one of them is private and the other
is not. The shipped examples mark it:

```
DeepSeek-V4-Flash ☁ cloud     leaves your machine
DeepSeek-V4-Flash ⌂ sparks    your hardware
Gemma4-E4B ⌂ on-box           served locally by this endpoint
```

**Probe before you list.** On Ollama, cloud models need the `:cloud` tag — the library
page says `qwen3.5:397b`, the resolvable id is `qwen3.5:cloud`. Some library entries do
not resolve at all, and some bill extra usage instead of plan usage. Every model in the
shipped example was probed against a live endpoint first.

Endpoints that cannot share a host (a local vLLM plus Ollama, say) stay separate lanes —
that is what `podsh lanes` and `--model` routing are for.

### Non-DeepSeek models

They work. `podsh/examples/qwen-vllm.patch.yml` is a tested overlay for Qwen3.8-27B on
vLLM — verified end to end including **tool calls** (the agent loop runs: real `bash`
invocation, real result). Two things to know:

```bash
export DEEPSEEK_BASE_URL=http://<vllm-host>:8010/v1
export PODSH_PATCH=$PWD/podsh/examples/qwen-vllm.patch.yml
podsh send --model deepseek-official/<your-model> --effort off   # ← set both, explicitly
```

1. **Use `--effort off`** — see the effort table below; the adapter's values and your
   backend's values may not overlap at all.
2. **Select the model explicitly on first use.** A new session inherits the last global
   selection, which can beat your overlay's default and 404 against the new endpoint.

The provider route stays `deepseek-official` — that is dsh's adapter id, not a claim
about which model you are running.

## Gotchas we hit so you don't

- **First boot is silent and slow.** The first `podsh web` (or the first attach that
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
- **🔴 Reasoning-effort vocabularies do not agree, and nothing validates across the seam.**
  Measured against three backends:

  | Layer | Accepts |
  |---|---|
  | dsh adapter (what the picker offers) | `off` `high` `max` (rc.6) / `+low` (rc.8) |
  | Ollama API | `high` `medium` `low` `none` |
  | vLLM (Qwen3.8) | `xhigh` `medium` `low` |

  The adapter validates your choice against *its* list, the backend rejects from *its* list,
  and the two can have an empty intersection — so a legal-looking effort is a hard 400 at
  turn time. **`off` is the portable choice**; it is what makes a non-DeepSeek backend work.
- **Panes inherit the herdr *server's* environment, not your shell's.** If you set
  `PODSH_HOST` (or any env) in a launcher, an already-running herdr server won't have it —
  relaunching the client connects back to the same server. Kill the server first, then start
  fresh. This is how you point one podr's panes at a specific dsh lane:

  ```bash
  PODSH_HOST=127.0.0.1:3081 ./podr   # panes inherit it
  podsh attach                        # no --host needed
  ```
  (Isolate with herdr's own `--session <name>`, as `./podr` does — never by overriding
  `XDG_CONFIG_HOME`/`XDG_STATE_HOME`, which are global and will break mise/direnv/etc.
  in every pane.)
- **Model selection is sticky.** A new session inherits the last selection, which can beat
  your overlay's default — pass `podsh send --model …:cloud --effort high` explicitly when
  lane-hopping.

## Status — read this

- **dsh is pre-1.0 and moving.** Everything here is validated against the
  pinned version in `podsh/podsh` (`DSH_PIN`). Don't float latest; bump the pin
  deliberately and re-test.
- The wire protocol facts the clients rely on were derived from dsh's shipped
  contract layer and verified live; upstream has promised breaking changes.
- Tracks upstream herdr by merge. Same build, same license (Apache-2.0).

## Credits

- [herdr](https://github.com/herdrdev/herdr) — the upstream herd.
- [Ahmed Al Busaidy](https://github.com/ahmedalbusaidy) — the reasonix
  detection integration this fork builds on.
- [DeepSeek](https://github.com/deepseek-ai) — dsh and the whales themselves.
- Upstream herdr README: [README.upstream.md](README.upstream.md) · [简体中文](README.upstream.zh-CN.md).

🐋 *ScrappyLabs — bring your own AI.*
