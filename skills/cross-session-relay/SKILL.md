---
name: cross-session-relay
description: "Use when a ChatGPT controller dispatches work to named WebCodex web sessions or local Codex Runner tasks."
---

# WebCodex 跨会话 relay

把 WebCodex 作为项目的唯一执行面：网页 Chat 负责理解 GitHub 状态、选择目标和验收方式；relay 只校验既定 RouteDecision、原文转发、等待 durable receipt 并把结果回传总控。

## 路由契约

总控优先输出严格 JSON，至少包含 `version`、`destination`、`prompt`、`mode` 和 `acceptance`。`destination.kind` 只能是 `web_chat` 或 `local_runner`。网页目标必须使用 profile 已登记的 `alias`；本地目标的 `project` 必须与 profile 的本地 Project 完全相同。总控可以为本地任务指定白名单 `model` 和 `reasoning_effort`；缺省为 `gpt-6-astra` / `medium`。

先程序化解析。只有 JSON 形状明显但格式损坏时，才调用一次只读格式修复器（`gpt-5.6-luna`、`xhigh`），然后对结果重新校验。修复器不能换目标、规划任务或执行工具；仍失败就记录 `rejected`。

## 执行与限速

- `web_chat` 使用 `POST /api/chat/session` 的 `send`，保存 `operation_id`，再轮询 `operation`；完成后用 `read` 取完整消息。
- `local_runner` 通过项目绑定的 WebCodex Connector/MCP 启动本地 Codex CLI，保存 `task_id`，轮询 `task_review`，回传 stdout、状态和失败原因。
- 同一 Ego TaskSpace 串行发送；遵循 profile 的 `min_send_interval_ms` 和 provider 的 `retry_after`，没有 retry-after 时指数退避，最长五分钟。不要并发重放。
- 只在 operation/task receipt 和独立 read-back 都确认后报告“已送达”。

## 未知结果与恢复

响应丢失、超时、空回复或 malformed response 都进入 `unknown`，禁止盲目重试。自动恢复只接受确定证据：provider read-back 中必须恰好有一条正文与原请求规范化相等的 `user` 消息，且其紧邻下一条是非思考、非空的 `assistant` 消息；随后调用 `reconcile` 收口原 operation。只看到一条 assistant 文本、只看到旧消息或只等待了足够久，都不算证据。

总控自己的 operation 也进入 `unknown` 时，保持锁定并给总控发送一次幂等的 `webcodex.relay.failure.v1` 失败收据。只有人工独立核验确认没有 assistant 回复后，才能手工调用 `resolve_unknown` 记录 `failed/unknown_resolved` 并释放 session；不能按年龄自动执行，不能直接改 SQLite，不能新建总控绕过锁，也不能重放原任务。

如果回传总控失败，状态为 `reply_unknown`；先 read-back 或 reconcile 回传操作，不得再次执行目标任务。只有明确的 pre-dispatch writable-slot 占用且尚未创建 `task_id` 时，才可按退避自动重试。

## Session、Project 与浏览器

`wc_chat_*` 是 durable WebCodex session，Ego Page 只是临时绑定。首次 send 才在精确的 `web_project_url` 下创建原生 Chat；旧 Chat 不能事后认领。每个项目显式绑定一个既有 Ego TaskSpace：HZ OS 使用 Space 1，QuantCompany 使用 Space 2，Space 3 仅作开发测试。不要复制 Cookie、调用 ChatGPT 私有接口或猜测 Chat URL。

每个 profile 只运行一个 relay worker，checkpoint 使用 0600 权限。测试 Chat 完成后按用户授权缓慢归档，并从 catalog/route registry 移除；关闭页面不等于归档。

参考实现：`docs/relay-control-plane.zh-CN.md`、`docs/chat-session.md`、`~/.config/webcodex/config/<profile>.json`。
