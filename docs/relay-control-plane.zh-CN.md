# WebCodex 控制面 relay

WebCodex 的统一 Chat runtime 现在可以接管原来由人工或 heartbeat 维护的总控 relay。浏览器只负责 Ego Browser 页面触达，WebCodex 负责项目 profile、路由、幂等、等待、回执和自动回复。每个项目使用同一份代码，只换配置。

## 总控知道什么，relay 做什么

新建的总控 Chat 在 bootstrap 时知道自己的职责和已登记的目标别名：QuantCompany 是 QC01–QC05；HZ OS 至少是 PR15、PRODUCT_MAP、LOCAL_RUNTIME 和 INDEPENDENT_REVIEW，并另有本地 Runner 路由。两套工作的目标源仍是 GitHub：QuantCompany 以 `luxiaolei/quantcompany#7` 及其 #8–#12 工作包为入口，HZ OS 以 `luxiaolei/huazhuo-blueprint#19` 为协调台账，并关联 `luxiaolei/huazhuo-runtime#1/#8`。这些 Issue/PR 记录目标、负责人、精确版本、证据、阻塞和下一接收者；它们不是 relay 自己生成的第二账本。

当前 relay 是执行面，不是 GitHub 规划器。它只处理总控消息中的显式 `[to:ALIAS]` 或 profile 已登记的别名，按固定 alias → `wc_chat_*` 映射调用目标 Chat，等待 operation 完成，再把 `[from:ALIAS]` 回贴总控。每个 profile 一个 worker，并在共享 Ego TaskSpace 中串行发送、限速和落 checkpoint。它不会自行轮询 GitHub、判断哪个工作包已完成、在 Chat 与本地 MCP 之间选路，也不会自动决定哪些任务并行或串行。

如果要实现“总控读 Issue 后自动选 Chat、Session 或本地工具”的自治调度，总控必须拥有可验证的 GitHub 读取能力和 WebCodex MCP 本地工具连接，再由一个带明确并行/串行规则的 coordinator 生成显式路由指令。当前实现已经提供 durable Chat relay 和独立的 ChatGPT Work → WebCodex MCP → Runner 路径，但没有把两者伪装成一个已经存在的自动规划器；未产生真实 operation、工具结果和 Issue/PR 回写前，不应声称任务已推进。

## 边界

旧 Chat 不能事后认领为 WebCodex durable session。每个项目要由 WebCodex 用对应的 ChatGPT Project URL 创建一个新的总控 Chat，再创建目标 Chat；旧总控可以在切换期间保留为只读迁移来源。真正切换完成后，旧 relay heartbeat 应暂停，避免两个控制面同时转发。

Ego Browser 的 TaskSpace 仍是唯一浏览器运行时。不要复制 cookies、调用 ChatGPT 私有接口或猜测 Chat URL。`web_project_url` 必须是已登录账号可访问的精确 Project URL，目标 alias 必须由 profile 显式登记。

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

每个 profile 只能有一个 worker；检查点写入 `~/.config/webcodex/relay/<profile>.json`，文件权限为 0600。事件状态是 `forwarding`、`forwarded`、`replied`、`reply_unknown`、`unknown`、`unrouted` 或 `rejected`。`unknown` 不会盲目重试；需要人工检查后再处理。

总控消息推荐包含显式目标标记，例如：

```text
[to:QC02]
请核对本轮数据质量并返回完整证据。
```

为兼容 HZ OS 旧总控的口头路由，profile 也可以为 alias 登记固定中文名称，worker 会识别“转发给‘收敛技术 PR15’”或 `forward to PR15`。没有显式标记或登记名称的消息会进入 `unrouted`，不会猜测目标。

worker 把整段原文发送给目标，等待 WebCodex operation 进入 `completed`，再把 `[from:QC02]` 加到回执前并发送回总控。若目标返回 `Thinking failed`，只在同一目标 Chat 发送一次 `continue`；仍不明确就保留 `unknown`。自动回复失败会进入 `reply_unknown`，不会声称已送达。

网页端请求由 provider 和 relay 两层共同限速：同一 TaskSpace 的发送默认至少间隔 15 秒；看到 ChatGPT 的 “Too many requests” 或 429 时，安全的发送前失败会进入 `rate_limited`，回执阶段会进入 `reply_rate_limited`，按 30 秒、60 秒、120 秒递增等待，最长 5 分钟后再恢复。已经提交到网页端、但结果不明的 turn 不会自动重放，会保留为 `unknown`，避免重复执行本地任务。需要调整时，在运行时 profile 中设置 `min_send_interval_ms` 和 `rate_limit_backoff_ms`；轮询默认是 5 秒。

## 切换旧 relay

先用 `--once` 做单轮检查，再让新 profile 连续运行。确认总控收到一条 `[from:...]` 回执、目标 Chat 收到原文、检查点落盘后，暂停旧的 `quantcompany-relay` 或 `hz-os` heartbeat。不要在新 worker 尚未产生真实回执前停掉旧控制面。

## 运行证据

静态检查和路由单测：

```bash
node --test scripts/tests/webcodex-relay.test.mjs
node --check scripts/ego-chatgpt-web-provider.mjs
node --check scripts/webcodex-relay.mjs
node --check scripts/webcodex-relay-init.mjs
```

真实验收要分别确认：新 Chat 的 Project URL、目标 Chat 的 Project URL、WebCodex operation 状态、目标回执、总控自动回复和 checkpoint。浏览器页面被用户接管时，provider 必须停止并把事件保留为 `unknown`，不能抢回 TaskSpace。

每个项目的完整 session/Runner 清单保存在本机的 0600 catalog 中，而不是 Git：`~/.config/webcodex/config/quantcompany-catalog.json` 和 `~/.config/webcodex/config/hz-os-catalog.json`。`active` 才能派发；`created_unbound` 表示 WebCodex session 已建但还没有在 Ego Page 上完成首次 bootstrap；`blocked` 或 `pending_router_binding` 只能回报缺口，不能自动发送。测试 Chat 归档后必须从 catalog 删除，不能只从浏览器页面关闭。
