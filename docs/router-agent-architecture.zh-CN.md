# 总控、路由 Agent 与执行端

这套系统把“决定下一步”和“执行下一步”分开。网页 Chat 总控负责业务上下文和目标确认；项目内的本地路由 Agent 负责读取可核验状态、选择执行面并生成明确派发；WebCodex relay、ChatGPT Web Chat 或本地 Runner 负责实际执行和返回收据。

```text
GitHub Issue / PR / 评论
          │ 只读事实
          ▼
┌──────────────────────┐
│ Project 总控 Chat     │ 维护目标、优先级、验收边界
└──────────┬───────────┘
           │ 总控回复 / 原文
           ▼
┌──────────────────────┐
│ 本地 Router Agent      │ 读 Issue + PR + 本地状态
│ 生成 RouteDecision     │ 选择 Web Chat 或 Local Runner
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
            Router → 总控 Chat
```

## 四个边界

总控 Chat 只承担目标、上下文和下一步授权。它不能用一句“已完成”替代 Issue、PR、operation 或 Runner 收据。

Router Agent 是每个项目的本地协调者。它先读取对应 GitHub 台账和最新精确版本，再读取 WebCodex session、MCP Project、Runner 状态，输出结构化 `RouteDecision`：

```json
{
  "destination": {"kind": "web_chat", "alias": "QC03"},
  "mode": "serial",
  "source": {"issue": "luxiaolei/quantcompany#10", "sha": "..."},
  "reason": "共享集成文件由 QC03 负责",
  "acceptance": ["operation completed", "PR head recorded"],
  "status": "LOCAL_UNVERIFIED"
}
```

Dispatcher 只执行 RouteDecision，不重新猜目标。网页目标使用固定 `alias → wc_chat_*`；本地目标使用固定 WebCodex Project/Runner。所有发送都有 idempotency key、operation/task id 和 checkpoint。

Receipt Store 保存原文、路由决定、目标、尝试次数、结果、Issue/PR 回写位置和 `unknown` 原因。网页响应不明、Runner 丢回执或 GitHub 读取失败时保留 `unknown`，不盲重试。

## 并行与串行

独立 Issue、独立工作区和不重叠写路径可以并行。共享 schema、同一文件、集成、合并、部署和本机验收必须串行，并指定唯一 owner。每个 Project 固定绑定一个 Ego TaskSpace，发送间隔和 rate-limit backoff 在各 Space 内生效；并行是任务级别的并行，不是浏览器页面无上限并发。

## 两个项目的路由表

QuantCompany 的业务台账是 `luxiaolei/quantcompany#7`，工作包是 #8–#12；路由目标应覆盖 QC01、QC02、QC03、QC04、QC05，以及 `LOCAL_RUNNER`。QC03 负责运行集成，QC05 独立审查，合并与本地验收不能绕过总控。

HZ OS 的唯一协调台账是 `luxiaolei/huazhuo-blueprint#19`，运行证据在 `luxiaolei/huazhuo-runtime#1/#8`；路由目标至少覆盖收敛技术 PR15、设计全业务产品地图、本地运行与验收、只读独立评审，以及 HZ OS Project 内的 `LOCAL_RUNNER`。运维、知识/Agent、入口和财务法务等工作包是否继续保留为独立 Chat，应由 #19 的当前状态确认，不按历史测试 Chat 自动恢复。

## 页面与 session 生命周期

`wc_chat_*` 是 durable session；Ego Browser Page 只是临时绑定。每个 Project 绑定一个既有 TaskSpace，但一个 TaskSpace 的页面数有限，不能把所有历史 Chat 永久保持打开。生产实现应允许 Router/Provider 按需绑定空闲 Page，完成 operation 后释放 Page；归档的测试 Chat 不得继续出现在 route registry。这样可以保留完整 session 资产，同时避免页面预算和 rate limit 把路由系统锁死。

当前 WebCodex relay 已完成“显式目标 → Web Chat → 回执”执行面；本地 Router Agent 和 GitHub 驱动的动态 RouteDecision 是下一层，需要真实 MCP/Runner 收据后才能宣称完成。
