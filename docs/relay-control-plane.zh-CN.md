# WebCodex 控制面 relay

WebCodex 的统一 Chat runtime 现在可以接管原来由人工或 heartbeat 维护的总控 relay。浏览器只负责 Ego Browser 页面触达，WebCodex 负责项目 profile、路由、幂等、等待、回执和自动回复。每个项目使用同一份代码，只换配置。

## 总控知道什么，relay 做什么

新建的总控 Chat 在 bootstrap 时知道自己的职责和已登记的目标别名：QuantCompany 是 QC01–QC05；HZ OS 至少是 PR15、PRODUCT_MAP、LOCAL_RUNTIME 和 INDEPENDENT_REVIEW，并另有本地 Runner 路由。两套工作的目标源仍是 GitHub：QuantCompany 以 `luxiaolei/quantcompany#7` 及其 #8–#12 工作包为入口，HZ OS 以 `luxiaolei/huazhuo-blueprint#19` 为协调台账，并关联 `luxiaolei/huazhuo-runtime#1/#8`。这些 Issue/PR 记录目标、负责人、精确版本、证据、阻塞和下一接收者；它们不是 relay 自己生成的第二账本。

当前 relay 是执行面，不是 GitHub 规划器。它只处理总控消息中的显式 `[to:ALIAS]` 或 profile 已登记的别名，按固定 alias → `wc_chat_*` 映射调用目标 Chat，等待 operation 完成，再把 `[from:ALIAS]` 回贴总控。每个 profile 一个 worker，并在该 Project 绑定的 Ego TaskSpace 中串行发送、限速和落 checkpoint。它不会自行轮询 GitHub、判断哪个工作包已完成、在 Chat 与本地 MCP 之间选路，也不会自动决定哪些任务并行或串行。

结构化 `destination.kind=web_chat` 和 `destination.kind=local_runner` 已纳入同一执行面。网页目标走 Chat Session API；本地目标先调用项目绑定的 `task_start`，再把总控可选提供的 `model` 和 `reasoning_effort` 白名单配置提交给 `commands_run`。未提供时使用 profile 默认的 `gpt-6-astra`、`medium`；`--ignore-user-config` 继续隔离无关的全局 MCP/插件配置，最后用 `task_review` 等待 durable execution。`destination.project` 必须与 profile 的 `project` 完全一致，否则 fail-closed；结果或失败原因再由 relay 回传总控。

“总控读 Issue 后自动选 Chat、Session 或本地工具”的规划发生在网页端总控 Chat：它读取 GitHub，决定目标、串行/并行和验收，再生成显式 `[to:ALIAS]` 或结构化 `destination`。本地 Thread Agent 是轻量适配器，只校验这个目标、原文转发并等待 operation/task receipt；它不读取 GitHub、不生成 RouteDecision、不改变总控决定。当前实现提供 durable Chat relay 和独立的 ChatGPT Work → WebCodex MCP → Runner 路径；未产生真实 operation、工具结果和 Issue/PR 回写前，不应声称任务已推进。

## 边界

旧 Chat 不能事后认领为 WebCodex durable session。每个项目要由 WebCodex 用对应的 ChatGPT Project URL 创建一个新的总控 Chat，再创建目标 Chat；旧总控可以在切换期间保留为只读迁移来源。真正切换完成后，旧 relay heartbeat 应暂停，避免两个控制面同时转发。

Ego Browser 是唯一浏览器运行时。每个本地 WebCodex Project 必须显式绑定一个既有 Ego TaskSpace；当前约定是 HZ OS → Space 1、QuantCompany → Space 2，Space 3 只用于开发测试。不要复制 cookies、调用 ChatGPT 私有接口或猜测 Chat URL。`web_project_url` 必须是已登录账号可访问的精确 Project URL，目标 alias 必须由 profile 显式登记。

## 创建一个项目 profile

先启动统一 runtime，并确认 Ego Browser provider 已经 setup：

```bash
scripts/webcodex-chat-runtime.sh setup
scripts/webcodex-chat-runtime.sh start
```

复制对应模板，填入 WebCodex 可见的本地 `project` id 和 ChatGPT Project 的 `/g/.../project` URL：

```bash
cp config/relay/quantcompany.bootstrap.example.json /secure/path/quantcompany.bootstrap.json
node scripts/webcodex-relay-init.mjs --config /secure/path/quantcompany.bootstrap.json
```

`webcodex-relay-init.mjs` 会调用真实的 `POST /api/chat/session`，为总控和每个目标创建 session，按指定 Project URL 首次打开页面，发送一次角色约束，然后把生成的 `wc_chat_*` id 写回配置。token 只从环境变量 `WEBCODEX_TOKEN` 读取，不写入示例文件。

QuantCompany 使用 `config/relay/quantcompany.bootstrap.example.json`；HZ OS（`LanYu-Tech/huazhuo-blueprint` 体系）使用 `config/relay/hz-os.bootstrap.example.json`。HZ OS 的别名默认覆盖总控当前使用的“收敛技术 PR15”“设计全业务产品地图”和“本地运行与验收”。目标增加或改名只改 profile。

## 启动 relay

初始化完成后，配置会变成运行时格式：

```bash
WEBCODEX_TOKEN="..." \
  WEBCODEX_RELAY_CONFIG=/secure/path/quantcompany.bootstrap.json \
  scripts/webcodex-chat-runtime.sh relay
```

每个 profile 只能有一个 worker；检查点写入 `~/.config/webcodex/relay/<profile>.json`，文件权限为 0600。事件状态是 `forwarding`、`forwarded`、`replied`、`reply_unknown`、`unknown`、`unrouted` 或 `rejected`。`unknown` 不会盲目重试；worker 会先用 provider 独立 read-back 对账，只有证实 assistant 回执后，才可用 Chat Session API 的 `reconcile` action 收口原 operation。

总控消息推荐包含显式目标标记，例如：

```text
[to:QC02]
请核对本轮数据质量并返回完整证据。
```

需要交给本地 Codex CLI 时，总控也可以返回结构化信封：

```json
{
  "version": 1,
  "destination": { "kind": "local_runner", "project": "agent:local:quantcompany" },
  "prompt": "检查本轮数据质量并修复失败项。",
  "mode": "serial",
  "acceptance": ["返回检查结果", "保留失败证据"],
  "model": "gpt-5.6-luna",
  "reasoning_effort": "low"
}
```

其中 `destination.project` 必须与 profile 的 `project` 完全相同；profile 初始化会把
这个绑定保留到运行时配置中。`model` 和 `reasoning_effort` 只对 `local_runner` 有效，
并按模型白名单校验；网页 Chat 路由携带它们会 fail-closed。可用模型是
`gpt-6-astra`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5` 和
`gpt-5.3-codex-spark`，reasoning 档位还会按所选模型再次校验。Relay 不替总控选择项目或
模型，也不会把目标改投到其他 Project。

为兼容 HZ OS 旧总控的口头路由，profile 也可以为 alias 登记固定中文名称，worker 会识别“转发给‘收敛技术 PR15’”或 `forward to PR15`。没有显式标记或登记名称的消息会进入 `unrouted`，不会猜测目标。

worker 把整段原文发送给目标，等待 WebCodex operation 进入 `completed`，再把 `[from:QC02]` 加到回执前并发送回总控。若目标返回 `Thinking failed`，只在同一目标 Chat 发送一次 `continue`；仍不明确就保留 `unknown`。自动回复失败会进入 `reply_unknown`，不会声称已送达。网络响应丢失但 provider 已独立读到 assistant 内容时，使用 `POST /api/chat/session` 的 `{"action":"reconcile","operation_id":"...","assistant_body":"..."}` 完成 durable 记录；下一轮 worker 会先尝试这次对账，确认已执行后再补发回总控，不会重发目标任务。没有独立证据时保持 `unknown`，由总控决定重试模型、换目标或暂停。Runner execution 成功且 `task_review` 证实工作区 clean 时，relay 自动调用 `task_cancel` 收口任务；有变更的 writable task 不会被自动取消。只有未创建 `task_id` 且错误明确为 writable slot 占用的 `unknown` 才会在 backoff 后重试；失败收据发送本身也有独立幂等键和状态。

如果总控自己的发送操作也进入 `unknown`，WebCodex 会故意拒绝下一次发送，避免重复写入。relay 默认保留这个状态；它只会在 provider 独立 read-back 找到“唯一一条同正文 user 消息后紧邻的非思考 assistant 消息”时调用 `reconcile` 收口原 operation。没有这种确定证据时，必须保持 `unknown`，通过一次幂等失败收据让总控决定重试、换目标或暂停。只有人工完成独立核验后，才可直接调用 `resolve_unknown` 把操作标记为 `failed/unknown_resolved`；这个动作不写入 assistant 消息、不声称任务成功，也不能按时间阈值自动触发。禁止直接改 SQLite、用新总控绕过旧状态或重放原任务。

网页端请求由 provider 和 relay 两层共同限速：同一 TaskSpace 的发送间隔由 profile 的 `min_send_interval_ms` 控制（QuantCompany 当前为 30 秒；代码默认值为 15 秒）。Provider 优先复用已经绑定的 Ego Browser 页面，不为每次发送新开页面；达到页面预算时只回收 relay 登记且当前没有待发送内容的旧页面，不打断正在运行的网页任务。页面出现限速提示时保持绑定、停止提交并退避。看到 ChatGPT 的 “Too many requests” 或 429 时，安全的发送前失败会进入 `rate_limited`，回执阶段会进入 `reply_rate_limited`，优先遵循 provider 的 `retry_after`，缺失时使用 `rate_limit_backoff_ms`，单次最长等待 5 分钟后再恢复。已经提交到网页端、但结果不明的 turn 不会自动重放，会保留为 `unknown`，避免重复执行本地任务。轮询默认是 5 秒。

## 切换旧 relay

先用 `--once` 做单轮检查，再让新 profile 连续运行。确认总控收到一条 `[from:...]` 回执、目标 Chat 收到原文、检查点落盘后，暂停旧的 `quantcompany-relay` 或 `hz-os` heartbeat。不要在新 worker 尚未产生真实回执前停掉旧控制面。

## 运行证据

Provider 的 `/healthz` 返回 `revision`（已加载源码的 SHA-256 前 12 位）；部署时应与本地 provider 文件核对，端口在线本身不能证明新代码生效。Ego 启动器为每次加载使用独立模块 URL，避免 helper 缓存旧模块。并行观察只写回各自会话字段，同一会话共用一次页面获取；页面导航失败仍保留标签绑定，后续恢复不重复开页。

静态检查和路由单测：

```bash
node --test scripts/tests/webcodex-relay.test.mjs
node --check scripts/ego-chatgpt-web-provider.mjs
node --check scripts/webcodex-relay.mjs
node --check scripts/webcodex-relay-init.mjs
```

真实验收要分别确认：新 Chat 的 Project URL、目标 Chat 的 Project URL、WebCodex operation 状态、目标回执、总控自动回复和 checkpoint。浏览器页面被用户接管时，provider 必须停止并把事件保留为 `unknown`，不能抢回 TaskSpace。

每个项目的完整 session/Runner 清单保存在本机的 0600 catalog 中，而不是 Git：`~/.config/webcodex/config/quantcompany-catalog.json` 和 `~/.config/webcodex/config/hz-os-catalog.json`。`active` 才能派发；`created_unbound` 表示 WebCodex session 已建但还没有在 Ego Page 上完成首次 bootstrap；`blocked` 或 `pending_router_binding` 只能回报缺口，不能自动发送。测试 Chat 归档后必须从 catalog 删除，不能只从浏览器页面关闭。

## 已验证的闭环（2026-09-13）

- **网页 Chat relay：通过。** 在隔离的 WebCodex Server、Ego Browser Provider 和 QuantCompany Project 上，结构化 `web_chat` 路由被程序化解析，发送到指定目标 Chat；目标返回后，relay 将 `[from:ALIAS]` 回传总控。`operation` 完成、总控 `read` 可见完整消息链，发送间隔按 30 秒测试配置执行，未出现新的 429。
- **Chat/MCP → 本地 Runner → Codex CLI：通过。** `task_start`、`files_list`、`commands/run` 成功在隔离 Project 中启动本地 `codex exec` 只读任务，进程以退出码 0 完成。该仓库没有可识别的 validation recipe，因此没有伪造 `task_finish` 成功；任务已清理取消，且没有修改工作树。
- **统一 `local_runner` relay：实现与隔离测试通过。** 结构化路由会校验 profile Project，创建 Runner task，提交 `codex exec`，轮询 `task_review`，并把 Worker stdout 或明确失败状态回传总控；跨 Project 路由会 fail-closed。当前记录的是 Runner/Connector 隔离测试；要在真实账号上验收，仍需按上面的清单运行一次 live profile。
