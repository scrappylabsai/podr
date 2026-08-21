# podr 🐋

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

> **herdr 放牧 agent，podr 放牧鲸鱼——顺带把其他的也一起牧了。**

这是 [herdr](https://github.com/herdrdev/herdr) 的一个 fork，把 DeepSeek 这套工具
链接成了「herd」里的一等公民——因为一群鲸鱼（pod）本来就是一个 herd。upstream herdr
支持的每一个 agent（claude、codex、gemini 等二十多个）在这里完全照旧，podr 只是不再
把鲸鱼关在门外。

**用 dsh 不该像二等公民。它是深海之王。**

如果你在跑 **reasonix**（DeepSeek 原生语音 agent），多半也会想跑 **dsh**
（DeepSeek Harness）。两个都跑起来之后，你会希望终端复用器能真正*看见*它们：
哪个窗格在干活、哪个卡在审批上、哪个在等你。这就是 podr。

## pod 里有什么

| 组成 | 作用 |
|---|---|
| **herdr fork** | upstream herdr 的全部功能，外加检测注册表里的两个 agent |
| **`Agent::Reasonix`** | 跟踪 reasonix 窗格的 working/blocked 状态（审批面板、提问卡片、回合/工具 spinner，规则对多语言安全） |
| **`Agent::Dsh`** | 通过下面的 `podsh attach` 把 dsh 会话纳入 herd |
| **`podsh/`** | dsh web host 的终端界面：`attach`（实时跟随 + 驱动）、`send`（在任意 shell 里编排会话）、一个轻量启动器 |

## 关键点：会「主动汇报」的 agent

复用器里其他所有 agent 都靠**扫屏**来跟踪——几百条正则去匹配终端网格，agent 的
界面一改就失效。

podr 的 `dsh` agent 把这件事反了过来。dsh 的客户端本质是「React 跑在协议之上」
（HTTP RPC + 一条 WebSocket 事件流），所以 `podsh attach` 只是**另一个客户端**；
而既然这个客户端是我们自己写的，它就可以**主动广播状态**，不需要被逆向：

```
✳ dsh · my session      空闲
⠿ dsh · my session      工作中（回合进行中）
⏸ dsh · approval        阻塞（在等你）
```

三条 OSC 标题规则，不匹配任何屏幕内容。它不会「漂移」，因为读规则的 manifest 和发
标题的客户端是同一份约定（`src/detect/manifests/dsh.toml`）。

## 快速开始

```bash
# 1. 构建 fork（vendored 终端内核需要 zig）
ZIG=/path/to/zig LIBGHOSTTY_VT_SIMD=false cargo build --release

# 2. 把 podsh 放进 PATH，并指向你的模型端点
#    （podsh 会检查 node >= 22.15——这是 dsh 的硬性下限——不满足会直接告诉你）
export PATH="$PWD/podsh:$PATH"
export DEEPSEEK_BASE_URL=http://localhost:8000/v1   # 任何 OpenAI 兼容端点
export DEEPSEEK_API_KEY=local

# 3. 启动——./podr 会在自己的具名 herdr 会话里跑这个 fork，
#    podsh 已经在 PATH 里；然后开一个窗格：
./podr
podsh attach
```

`./podr` 的 socket 和状态与你已有的 herdr 完全隔离，所以可以放心试用而不影响现有环境。

`podsh attach` 会找到正在运行的 dsh web host（或启动一个），实时跟随最近的会话，并加入 herd。

它的形态和你已经在用的其他 agent CLI 一样：输入框固定在底部，对话记录在上方滚动。
**直接打字就行** —— 不需要先切换到某个模式。

```
╭────────────────────────────────────────────────────────────────╮
│ ❯ 跑一遍测试，把失败的用例总结给我                             │
╰────────────────────────────────────────────────────────────────╯
  / 命令 · ↑ 历史 · \ + enter 换行   ⠹ working · deepseek-v4-flash · effort high
```

- **enter** 发送。回合正在进行时，它会**介入这个回合**；想排到回合之后再执行就用
  `/queue <文本>`。`\` + enter（或 alt+enter）换行。
- **esc** 打断正在进行的回合 —— 如果输入框里有内容，第一次按会先清空它。
  **ctrl+c** 按两次离开窗格；会话本身继续运行。
- **↑/↓** 翻历史（存在 `~/.podsh/history`），readline 那套键位都在：
  ctrl+a/e、ctrl+w/u/k、alt+←/→、ctrl+l 清屏。
- **审批和提问在等待期间会接管键盘** —— `y`/`1` 允许一次，`n`/`2` 拒绝，`1-9` 回答提问。
  浏览器标签页同时有效：谁先回应谁生效，另一端自动清除。
- **`/` 命令**：`/sessions` 切换会话（无需重连 —— 事件 mux 本来就带着全部会话），
  `/model` 是**模型 + 思考强度选择器**，另外还有 `/lanes`、`/cancel`、`/clear`、`/help`。
  其余的一律交给 host：`/compact`、`/plan`、`/permission`、`/goal`、`/export`、`/feedback`。
- **`--plain`** 保留旧的模式化键位（`l` `m` `i` `s` `c` · `y`/`n` · `1-9`），
  给装不下输入框的终端用；管道输出没有任何变化。

浏览器标签页和终端窗格是**同一个会话的两张面孔**——host 会把事件扇出给每一个已连接的
客户端，会话本身没有归属权。

```bash
# 在任意 shell 里编排：
podsh send --list
podsh send --session <id> --watch "跑一遍测试并总结失败项"
podsh send --steer "停，目录不对，用 ./services"
podsh send --models                     # 模型列表 + 当前选择 + 可路由性
podsh send --effort max                 # 只调思考强度，保持模型不变
```

## 通道（lane）：一个端点一个 host

一个 dsh host **就是**一条通道：一个端点、一份模型列表。你可以同时跑好几个（每个
provider 一个），podsh 会把模型解析到真正提供它的那条通道上——于是你只需要关心
「用哪个模型」，而不是「哪个端口」：

```bash
podsh lanes                          # 哪些通道在线，各自提供什么
podsh attach --model glm-5.2:cloud   # 自动连到有这个模型的通道
podsh send   --model qwen3.8-27b …   # 自动路由过去
```

用 `PODSH_LANES="host:port,host:port"` 显式指定，否则默认扫描 `127.0.0.1:3080-3099`。

## 我们踩过的坑，你就不必再踩

- **首次启动很慢而且完全没有输出。** 第一次 `podsh web`（或第一次由 attach 拉起的
  host）要安装 dsh 的 web profile，几分钟没有任何提示。它在正常工作，等着就好。
  **不要同时启动两个首次安装**（npm 缓存锁会损坏，报 `ECOMPROMISED`）。
- **🔴 版本 pin 只 pin 了一半。** `DSH_PIN` 固定的是 **launcher**
  （通过 npx 拉的 `@deepseek-ai/dsh`），但 launcher 随后安装的 **profile** 里那些
  插件包是在**首次启动时**解析的——也就是说它们会浮动到当时的最新版。同一个
  `DSH_PIN=0.1.0-rc.6`，实测两台机器分别得到 rc.6 和 **rc.8**。用这个查你自己的：

  ```bash
  ls ~/.dsh/profiles/*/node_modules/@deepseek-ai/dsh-base/package.json
  ```

  两边都能跑，但它们并不是同一套安装。需要可复现性就自己快照 `~/.dsh/profiles/`，
  别指望 pin 帮你做到。
- **🔴 思考强度（reasoning effort）的取值各层并不一致，而且没人做跨层校验。**

  | 层 | 接受的取值 |
  |---|---|
  | dsh adapter（选择器里显示的） | `off` `high` `max`（rc.6）/ 另加 `low`（rc.8） |
  | Ollama API | `high` `medium` `low` `none` |
  | vLLM（Qwen3.8） | `xhigh` `medium` `low` |

  adapter 拿**它自己**的列表校验你的选择，后端拿**它自己**的列表拒绝——两者的交集
  完全可能为空。于是一个看起来完全合法的取值，会在真正发起回合时直接 400。
- **🔴 默认模型列表是「参考性」的，不是真实的。** 不加 overlay 时，无论你的端点实际
  提供什么，它都会同时列出 `deepseek-v4-flash` 和 `deepseek-v4-pro`。所以在一个只
  提供 Flash 的 vLLM 上，Pro 看起来完全可选，然后在回合时 404。请声明端点真正提供的
  东西（`podsh/examples/sparks-vllm.patch.yml` 是单模型的例子）。
- **🔴 用 Ollama 时，列进去的每个云端模型都要 `ollama pull`。** web UI 会拿你声明的
  列表和端点**实际列出**的模型取交集，而 Ollama 对 `:cloud` 模型是按需拉起、注册前
  并不列出。结果就是：一个没注册的云端模型通过 API 完全能用，但在浏览器选择器里
  **根本看不见**。

  ```bash
  ollama pull glm-5.2:cloud      # 只写 manifest——不下权重，秒完成，不占磁盘
  ```
- **标注模型在哪儿跑。** 选择器只显示 display name，所以「本机 GPU 上的某模型」和
  「云端的同名模型」看起来一模一样——当其中一个涉及隐私、另一个不涉及时，这很致命。
  示例配置里的写法：`☁ cloud` 表示会离开你的机器，`⌂ sparks` 表示跑在你自己的硬件上。
- **切换模型是一个全局事件，而不是会话级的。** 这个选择存在
  `~/.dsh/settings.yaml` 里，是一份带版本号的 settings *document*；在任何地方改它都会
  在 `/api/events.host` 上触发 `settings/document-updated`，各客户端随之重新拉取。所以
  浏览器里改了，窗格里会同步——但它同时也改掉了**每条通道上新会话**的默认值。而且没有
  任何东西会校验这个选择对当前 host 是否有效：选一个本通道提供不了的模型是会被*接受*的，
  `routable` 依旧是 `true`，然后在下一个回合 404。
- **窗格继承的是 herdr *server* 的环境变量，不是你 shell 的。** 如果你在启动脚本里设了
  `PODSH_HOST`，而 herdr server 已经在跑，它并不会拿到——重启客户端只会连回同一个
  server。要先把 server 停掉。隔离请用 herdr 自带的 `--session <name>`（`./podr` 就是
  这么做的），**不要**去覆盖 `XDG_CONFIG_HOME`/`XDG_STATE_HOME`——那是全局的，会把窗格里
  的 mise/direnv 之类全部搞坏。

## 为什么是 fork

herdr 的贡献是由其维护者主导实现的，非邀请的实现型 PR 会按其策略被自动关闭——这是他们
明确写在文档里的选择，这里只是陈述，不是抱怨。reasonix 的检测支持我们已经通过他们的
discussions 提交过（#954，目前仍开放）。所以 reasonix 和 dsh 的 agent 支持就先放在这个
fork 里。它通过 merge 跟随 upstream，许可证同为 Apache-2.0，检测 manifest 也沿用他们的
格式——哪天他们想要其中任何一个，复制粘贴即可。

## 状态——请务必读

- **dsh 还在 1.0 之前，且在快速变动。** 这里的一切都是针对 `podsh/podsh` 里那个
  `DSH_PIN` 验证过的。不要浮动到 latest；要升就有意识地升，然后重测。
- 客户端依赖的协议细节来自 dsh 自带的 contract 层，并经过实机验证；upstream 已经预告
  会有破坏性变更。
- 通过 merge 跟随 upstream herdr。同样的构建方式，同样的许可证（Apache-2.0）。

## 致谢

- [herdr](https://github.com/herdrdev/herdr) —— upstream 的那个 herd。
- [Ahmed Al Busaidy](https://github.com/ahmedalbusaidy) —— 本 fork 所基于的 reasonix 检测集成。
- [DeepSeek](https://github.com/deepseek-ai) —— dsh，以及鲸鱼本身。
- upstream herdr 的 README：[README.upstream.md](README.upstream.md) ·
  [简体中文版](README.upstream.zh-CN.md)。

🐋 *ScrappyLabs — bring your own AI.*
