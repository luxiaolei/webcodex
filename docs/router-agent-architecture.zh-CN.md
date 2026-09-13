# 总控、路由 Agent 与执行端

这套系统把“决定下一步”和“执行下一步”分开。网页 Chat 总控读取 GitHub Issue/PR 和项目状态，决定目标、优先级、串行/并行方式和验收边界，并把这些决定写进显式派发消息。本地 Thread Agent 只是轻量执行适配器：解析并校验总控给出的目标，原文转发到指定 Chat 或本地 Runner，再回传真实收据。

## 先用白话看调用链

这里确实有一层父子 Codex CLI：Router Codex CLI 是父会话，Worker Codex CLI 是子会话。两者都可以使用 `gpt-6-astra`、`thinking=low`，但职责不同：

```text
Chat 总控
  ├─ 当前本地链：MCP / task_start → WebCodex Runner → task_id
  └─ 当前网页链：Chat Session API / send → operation_id → Ego Browser → 目标 Web Chat

目标统一入口（后续可加 route_dispatch）：
Chat 总控 → MCP route_dispatch → Router Codex CLI（父）
                                  ├─ destination=LOCAL_RUNNER → codex exec / resume → Worker Codex CLI（子）
                                  └─ destination=WEB_CHAT    → Chat Session API → Ego Browser → Web Chat
```

这里有三个关键结论：

1. Chat 总控负责读 GitHub、选择目标、决定串行/并行，以及在失败后是否改道。任务失败后不是本地 CLI 自己“猜”另一个 Chat；总控收到失败收据后再发第二次明确调用。
2. Router Codex CLI 负责理解总控信封和派发；Worker Codex CLI 只负责本地工作。Worker 不需要直接操作网页 DOM、Cookie 或 ChatGPT 页面；需要网页 Chat 时，由父 CLI / WebCodex 调用 Chat Session API，再由 Ego Browser 发送和读取。
3. 对外可以是一个 WebCodex MCP Server，但工具能力可以分成“本地任务”和“统一路由”两类。仓库当前已经有 `task_start` / `task_review`；`route_dispatch` 是把两条路径统一起来的后续接口，不应在尚未实现前当成现有能力。

长任务不要让一次 MCP/HTTP 调用挂着一小时。`send` 返回 `202 + operation_id`，本地任务返回 `task_id`；总控之后用 `operation` / `read` 或 `task_review` 查询，最终只接受 `completed`、`failed`、`unknown` 和对应的 durable receipt。

```text
GitHub Issue / PR / 评论
          │ 只读事实
          ▼
┌──────────────────────┐
│ Project 总控 Chat     │ 维护目标、优先级、验收边界
└──────────┬───────────┘
           │ 显式 destination + mode + 原文 + acceptance
           ▼
┌──────────────────────┐
│ 本地 Thread Agent       │ 轻量转发适配器
│ 校验显式目标并保留原文  │ 不读 GitHub、不做规划
└───────┬────────┬─────┘
        │        │
        │        └──────────────┐
        ▼                       ▼
┌───────────────┐       ┌────────────────┐
│ Web Chat       │       │ WebCodex MCP   │
│ 固定 session   │       │ Local Runner   │
│ Ego Browser    │       │ project bound  │
└───────┬───────┘       └───────┬────────┘
        └──────────┬────────────┘
                   ▼
          operation / task receipt
                   │
                   ▼
       Thread Agent → 总控 Chat
```

## 四个边界

总控 Chat 负责读取 GitHub 台账和运行状态，决定下一步的目标、优先级、串行/并行方式与验收边界。它必须把目标写成 `[to:ALIAS]`（或结构化 `destination`），并保留 Issue/PR、版本和验收依据；不能用一句“已完成”替代 operation 或 Runner 收据。

Router Codex CLI 不是第二个项目总控，也不读取 GitHub。它只接受总控已经生成的派发信封，校验目标属于当前 Project 和 Ego TaskSpace，然后启动 Worker Codex CLI，或调用 WebCodex relay/provider，把原文发送到指定网页 Chat，等待 operation/task receipt 并回报：

```json
{
  "destination": {"kind": "web_chat", "alias": "QC03"},
  "mode": "serial",
  "source": {"issue": "luxiaolei/quantcompany#10", "sha": "..."},
  "reason": "由总控 Chat 写入的派发原因",
  "acceptance": ["operation completed", "PR head recorded"],
  "status": "controller_decided"
}
```

上面的 `RouteDecision` 是总控 Chat 的输入，不是 Router 的重新规划结果。Router 不重新猜目标、不改写 mode、不读取 GitHub；网页目标使用固定 `alias → wc_chat_*`，本地目标使用固定 Project 和 Worker session。所有发送都有 idempotency key、operation/task id、父子 session_id 和 checkpoint。子 CLI 默认不再启动孙 CLI，递归深度固定为一层。

Receipt Store 保存总控信封、目标、尝试次数、operation/task 结果和 `unknown` 原因。Issue/PR 的读取、解释和回写仍由总控 Chat 负责；网页响应不明或 Runner 丢回执时保留 `unknown`，不盲重试。

## 并行与串行

独立 Issue、独立工作区和不重叠写路径可以并行。共享 schema、同一文件、集成、合并、部署和本机验收必须串行，并指定唯一 owner。每个 Project 固定绑定一个 Ego TaskSpace，发送间隔和 rate-limit backoff 在各 Space 内生效；并行是任务级别的并行，不是浏览器页面无上限并发。

## 两个项目的路由表

QuantCompany 的业务台账是 `luxiaolei/quantcompany#7`，工作包是 #8–#12；路由目标应覆盖 QC01、QC02、QC03、QC04、QC05，以及 `LOCAL_RUNNER`。QC03 负责运行集成，QC05 独立审查，合并与本地验收不能绕过总控。

HZ OS 的唯一协调台账是 `luxiaolei/huazhuo-blueprint#19`，运行证据在 `luxiaolei/huazhuo-runtime#1/#8`；路由目标至少覆盖收敛技术 PR15、设计全业务产品地图、本地运行与验收、只读独立评审，以及 HZ OS Project 内的 `LOCAL_RUNNER`。运维、知识/Agent、入口和财务法务等工作包是否继续保留为独立 Chat，应由 #19 的当前状态确认，不按历史测试 Chat 自动恢复。

## 页面与 session 生命周期

`wc_chat_*` 是 durable session；Ego Browser Page 只是临时绑定。每个 Project 绑定一个既有 TaskSpace，但一个 TaskSpace 的页面数有限，不能把所有历史 Chat 永久保持打开。生产实现应允许 Router/Provider 按需绑定空闲 Page，完成 operation 后释放 Page；归档的测试 Chat 不得继续出现在 route registry。这样可以保留完整 session 资产，同时避免页面预算和 rate limit 把路由系统锁死。

当前 WebCodex relay 已完成“总控显式目标 → 指定 Web Chat/Local Runner → 回执”执行面。两个项目的本地 Thread Agent 固定使用 `gpt-6-astra`、`thinking=low`，只做上述轻量适配；GitHub 驱动的规划仍在网页端总控 Chat 内完成。
