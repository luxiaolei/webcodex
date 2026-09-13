# WebCodex agent onboarding and unified Chat runtime

Use this page when handing WebCodex to another project or another agent. It
defines the two Project bindings, the two end-to-end paths, dependency
locations, and the reusable setup sequence.

## Two Project bindings

`project` and `web_project_url` belong to different systems:

| Field | Owner | Meaning |
| --- | --- | --- |
| `project` | WebCodex Runner | Required local Project and tool-permission boundary |
| `web_project_url` | ChatGPT Web | Optional native ChatGPT Project home for the first browser send |

`web_project_url` must be an HTTPS ChatGPT Project URL ending in `/project`, for
example `https://chatgpt.com/g/g-p-<id>-<slug>/project`. The first `send` opens
that home and submits the prompt; ChatGPT creates the native `/c/<chat-id>` Chat
there. Omitting it opens `https://chatgpt.com/` and creates a regular Chat. A
WebCodex session does not create a native Chat until its first send, and an
arbitrary existing ChatGPT conversation cannot be adopted later.

## End-to-end paths

1. **ChatGPT Web bridge:** `POST /api/chat/session` → durable WebCodex session
   and operation → Ego Browser → ChatGPT Project/Chat. Operations and messages
   are retained in WebCodex SQLite.
2. **ChatGPT-to-local tools:** ChatGPT Work → WebCodex MCP → `task_start` →
   Runner → files, Git, or commands → structured result. Both paths reuse the
   same WebCodex Server and registered local Projects; only the first path uses
   the browser provider.

Archify diagrams:

- [Runtime architecture](architecture/archify/runtime.architecture.html)
- [Create/send workflow](architecture/archify/chat-project.workflow.html)
- [Native Project sequence](architecture/archify/chat-project.sequence.html)
- [Binding and tool data flow](architecture/archify/session-dataflow.dataflow.html)
- [Session lifecycle](architecture/archify/chat-session.lifecycle.html)

Each HTML is standalone. The adjacent JSON is the reviewable Archify source.

## One-time machine setup

```bash
git clone https://github.com/luxiaolei/webcodex.git
cd webcodex
cargo build --workspace --bins
scripts/webcodex-chat-runtime.sh setup
scripts/webcodex-chat-runtime.sh start
```

The setup reuses the signed-in Ego Browser account and stores only the numeric
TaskSpace ID under `~/.config/webcodex/ego` (or `$XDG_CONFIG_HOME/webcodex/ego`).
Set `WEBCODEX_EGO_SPACE_ID` to reuse an existing TaskSpace. Do not copy cookies or
repeat browser setup per project. On a machine without Ego Browser, use the
explicit fallback:

```bash
export WEBCODEX_CHATGPT_WEB_PROVIDER=codex-chatgpt-web
scripts/webcodex-chat-runtime.sh setup
scripts/webcodex-chat-runtime.sh start
```

The fallback adapter is vendored at `vendor/codex-chatgpt-web`.

## Minimal API flow

```json
{"action":"create","title":"Research","project":"runner/project","web_project_url":"https://chatgpt.com/g/g-p-<id>-<slug>/project","idempotency_key":"create-1"}
{"action":"send","session_id":"wc_chat_...","body":"Run the small calculation","idempotency_key":"send-1"}
{"action":"operation","operation_id":"wc_chat_op_..."}
{"action":"read","session_id":"wc_chat_...","after_seq":0,"limit":100}
```

`send` is asynchronous and returns `202`. Keep `pending`, `completed`,
`failed`, and `unknown` separate. Timeouts, malformed responses, empty responses,
and ambiguous network results remain `unknown` until reconciled; never blindly
retry them. The session cannot change its local or native Project binding.

For the MCP path, connect the WebCodex endpoint in ChatGPT Work, call
`task_start(mode=read_only)`, save its `task_id`, then call `files_list` (or the
allowed Git/command tool) and verify the structured result. See the [MCP Work
surface smoke test](MCP.md#chatgpt-work-surface-smoke-test).

## Where dependencies live

| Dependency | Runtime role | Installation/configuration |
| --- | --- | --- |
| Rust/Cargo | Build and run WebCodex | System toolchain; repo `Cargo.toml`/`Cargo.lock` |
| WebCodex Server/Runner | Local service | This repository or an existing deployment |
| Ego Browser | ChatGPT Web provider | macOS app/account; TaskSpace ID in `~/.config/webcodex/ego` |
| `codex-chatgpt-web` | Explicit provider fallback | `vendor/codex-chatgpt-web` |
| Archify | Documentation only | `~/.agents/skills/archify` |
| Tunnel/HTTPS | Remote access when needed | System or Desktop/deployment configuration |

Install Archify once for documentation work:

```bash
npx --yes skills add tt-a1i/archify --skill archify --agent codex --global --copy --yes
```

Its entry point is `~/.agents/skills/archify/bin/archify.mjs`; it is not a
WebCodex runtime dependency. Validate, deliver, and browser-check a changed
diagram before publishing it:

```bash
ARCHIFY="$HOME/.agents/skills/archify/bin/archify.mjs"
node "$ARCHIFY" validate architecture docs/architecture/archify/runtime.architecture.json --quality showcase --json
node "$ARCHIFY" deliver architecture docs/architecture/archify/runtime.architecture.json docs/architecture/archify/runtime.architecture.html --quality showcase --json
node "$ARCHIFY" visual-check docs/architecture/archify/runtime.architecture.html --json
```

For the complete Chinese handoff, see [AGENT_ONBOARDING.zh-CN.md](AGENT_ONBOARDING.zh-CN.md).

