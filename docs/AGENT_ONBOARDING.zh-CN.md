# WebCodex Agent 接入与统一 Chat 运行时

这份文档给新的项目或新的 Agent 使用。它说明安装什么、装在哪里、两个
Chat 闭环分别怎么走，以及网页端 Chat 如何归属于指定的 ChatGPT Project。

## 先记住两个 Project

WebCodex 同时有两种 Project 绑定，它们不能混为一个字段：

| 字段 | 所属系统 | 作用 |
| --- | --- | --- |
| `project` | WebCodex Runner | 必填；决定本地文件、Git、命令和工具权限 |
| `web_project_url` | ChatGPT Web | 可选；决定第一次网页发送在哪个原生 ChatGPT Project 创建 Chat |

`web_project_url` 必须是完整的 HTTPS Project 首页，例如：

```text
https://chatgpt.com/g/g-p-<project-id>-<slug>/project
```

创建 WebCodex session 时保存这个 URL；第一次 `send` 会打开该 Project 首页并
提交消息，ChatGPT 随后创建 `/c/<chat-id>` 对话。后续发送复用同一个 Ego
Browser 页面和该 Project 绑定的 TaskSpace。省略 `web_project_url` 时，Provider 打开
`https://chatgpt.com/`，创建普通的非 Project Chat。创建 WebCodex session
本身不会在 ChatGPT 中创建 Chat，也不能事后把任意旧 Chat 认领进来。

## 两条闭环

```text
ChatGPT Web ── POST /api/chat/session ──> WebCodex Server
                                             │
                                             ├─ durable session / operation / messages
                                             ├─ Runner Project + local tools
                                             └─ Ego Browser ──> ChatGPT Web Project / Chat

ChatGPT Work ── MCP ──> WebCodex MCP ── task_start ──> Runner ──> files/git/command
```

第一条是 ChatGPT Web 回合桥接：网页端会话通过 Ego Browser 执行，结果写入
WebCodex SQLite。第二条是 ChatGPT 调用本地资源：MCP Work 会话启动 Runner
任务，再用 `files_list`、`git_*` 或命令工具读取结构化结果。两条链共用同一
个 WebCodex Server 和本地项目注册表，但 Provider 配置只需设置一次。

完整图见：

- [运行时架构图](architecture/archify/runtime.architecture.html)
- [创建与发送流程图](architecture/archify/chat-project.workflow.html)
- [网页 Project 创建时序图](architecture/archify/chat-project.sequence.html)
- [绑定与工具数据流图](architecture/archify/session-dataflow.dataflow.html)
- [session 生命周期图](architecture/archify/chat-session.lifecycle.html)

这些 HTML 是 Archify 生成的独立查看器；同名 `.json` 是可审查、可重新生成
的图规格。

## 一次性安装和运行

### 1. 获取仓库和 Rust 依赖

```bash
git clone https://github.com/luxiaolei/webcodex.git
cd webcodex
cargo build --workspace --bins
```

Cargo 依赖由仓库根目录的 `Cargo.toml`、各 crate 的 `Cargo.toml` 和
`Cargo.lock` 管理，缓存由 Cargo 放在当前用户的 Cargo home；不需要把依赖复制
到项目目录。

### 2. 复用已经登录的 Ego Browser

Ego Browser 是 ChatGPT Web Provider 的统一运行时。先确保该浏览器账号已经
登录并完成浏览器 setup，然后在仓库执行：

```bash
scripts/webcodex-chat-runtime.sh setup
scripts/webcodex-chat-runtime.sh start
```

setup 保存运行时状态（默认在 `~/.config/webcodex/ego`，也受
`XDG_CONFIG_HOME` 影响），复用现有账号，不复制 Cookie，也不要求每个项目重复登录。
每个本地 Project 必须在私有 `~/.config/webcodex/ego/project-spaces.json` 中绑定一个既有
TaskSpace；需要单一 Space 的兼容部署才设置：

可从 `config/ego/project-spaces.example.json` 开始，把占位符替换为本机准确的 WebCodex
Project ID，并将结果保存到 `~/.config/webcodex/ego/project-spaces.json`，权限设为 `0600`。

```bash
export WEBCODEX_EGO_SPACE_ID=<existing-space-id>
```

没有 Ego Browser 的机器才使用仓库内的显式 fallback：

```bash
export WEBCODEX_CHATGPT_WEB_PROVIDER=codex-chatgpt-web
scripts/webcodex-chat-runtime.sh setup
scripts/webcodex-chat-runtime.sh start
```

fallback 适配器位于 `vendor/codex-chatgpt-web`。它是兼容路径，不要在每个业务
项目内再复制一份 Provider。

### 3. 运行 WebCodex Server / Runner

按项目选择已有部署或本机运行：

```bash
cargo run -p webcodex -- server
cargo run -p webcodex-runner -- --help
```

生产部署、Tunnel、认证和项目注册仍以 [MCP 文档](MCP.zh-CN.md)、[部署指南](DEPLOYMENT.zh-CN.md)
和 [认证模型](AUTH_MODEL.zh-CN.md) 为准。不要把浏览器登录凭据写入提示词、Git 或日志。

## API 最小用法

先创建一个本地绑定，同时指定原生 ChatGPT Project：

```json
{
  "action": "create",
  "title": "Research",
  "project": "runner/project",
  "web_project_url": "https://chatgpt.com/g/g-p-<id>-<slug>/project",
  "idempotency_key": "create-1"
}
```

然后发送并轮询：

```json
{"action":"send","session_id":"wc_chat_...","body":"Run the small calculation","idempotency_key":"send-1"}
{"action":"operation","operation_id":"wc_chat_op_..."}
{"action":"read","session_id":"wc_chat_...","after_seq":0,"limit":100}
```

`send` 返回 `202` 和 operation ID。`pending`、`completed`、`failed`、`unknown`
必须分开处理；超时、空响应、格式错误或网络结果不明确时保留 `unknown`，先
对账再发送，不做盲目重试。session 的 Project 绑定一旦建立，不允许换成本地
Project 或另一个网页 Project。

## ChatGPT 调用本地工具的验收

MCP Work 闭环使用同一个已启动的 Server：

1. 在 ChatGPT Work 会话中连接 WebCodex MCP endpoint。
2. 调用 `task_start(mode=read_only)`，记录返回的 `task_id`。
3. 用 `files_list`（或项目允许的 `git_*`、命令工具）读取结果。
4. 检查结果带有 task、project 和结构化输出，再结束任务。

可复制的请求和证据标准见 [MCP Work-surface smoke test](MCP.zh-CN.md#chatgpt-work-闭环验收)。
浏览器 Chat 桥接和 MCP 本地工具是两条不同协议路径；一条通过 Ego Browser
执行网页回合，另一条通过 MCP 进入 Runner。

## 依赖安装位置

| 依赖 | 是否运行时必需 | 安装/配置位置 | 谁维护 |
| --- | --- | --- | --- |
| Rust、Cargo | 是 | 系统工具链；仓库 `Cargo.toml` / `Cargo.lock` | Rustup + 本仓库 |
| WebCodex Server / Runner | 是 | 本仓库构建产物或已有部署 | 本仓库 |
| Ego Browser | ChatGPT Web 闭环必需 | macOS 应用与已登录账号；TaskSpace ID 写入 `~/.config/webcodex/ego` | Ego Browser |
| `codex-chatgpt-web` fallback | 仅无 Ego 时 | 本仓库 `vendor/codex-chatgpt-web` | 本仓库 |
| Archify | 画图和文档构建，不是 WebCodex 运行时依赖 | Codex skill：`~/.agents/skills/archify` | Archify skill |
| Tunnel / HTTPS | 远程客户端按部署需要 | 系统或 Desktop/Tunnel 配置 | 部署环境 |

安装 Archify skill（只需为维护文档的 Agent 执行一次）：

```bash
npx --yes skills add tt-a1i/archify --skill archify --agent codex --global --copy --yes
```

安装后命令入口是：

```text
~/.agents/skills/archify/bin/archify.mjs
```

重新生成或验收图时：

```bash
ARCHIFY="$HOME/.agents/skills/archify/bin/archify.mjs"
node "$ARCHIFY" validate architecture docs/architecture/archify/runtime.architecture.json --quality showcase --json
node "$ARCHIFY" deliver architecture docs/architecture/archify/runtime.architecture.json docs/architecture/archify/runtime.architecture.html --quality showcase --json
node "$ARCHIFY" visual-check docs/architecture/archify/runtime.architecture.html --json
```

`validate` 是规格和几何检查，`deliver` 是确定性 HTML 产物检查，`visual-check`
是实际 Chrome 视口检查；三者都通过后才能把图当作交付物。Archify 只服务于
架构文档，不应作为业务运行时依赖被打进 WebCodex。

## 复用边界

- 一个登录账号和一个 Provider 可以服务多个 WebCodex 本地 Project；每个 Project 固定绑定一个既有 Ego TaskSpace。
- 每个 session 都必须绑定一个本地 `project`；网页归属用可选的
  `web_project_url` 单独声明。
- 原生 ChatGPT Project 的可见性、账号权限和网页 UI 由 ChatGPT/Ego 控制；
  API 只能验证并保存目标 URL，不能伪造成员资格。
- WebCodex 的 durable operation、messages 和 Runner 结果才是恢复依据；网页
  上看到的状态不能单独替代持久化回执。
- 如果要交给另一个人，只需让对方安装仓库依赖、登录自己的 Ego Browser、执行
  一次 runtime setup，再为自己的 Project 注册本地目录和网页 Project URL。
