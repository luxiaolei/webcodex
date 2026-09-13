# Chat session bridge

WebCodex exposes one authenticated GPT Actions/MCP-compatible endpoint:
`POST /api/chat/session`. It keeps a caller-owned session bound to an exact
Runner Project, optionally binds the browser turn to a native ChatGPT Project,
starts a ChatGPT Web Responses turn through the shared signed-in Ego Browser
provider, and retains messages and operation state in the WebCodex SQLite
store.

The request uses one of four actions:

```json
{"action":"create","title":"Research","project":"runner/project","web_project_url":"https://chatgpt.com/g/g-p-<id>-<slug>/project","idempotency_key":"create-1"}
{"action":"send","session_id":"wc_chat_...","body":"Run the small calculation","idempotency_key":"send-1"}
{"action":"operation","operation_id":"wc_chat_op_..."}
{"action":"read","session_id":"wc_chat_...","after_seq":0,"limit":100}
```

`send` returns `202` with an operation id. The operation transitions to
`completed`, `failed`, or `unknown`; a request timeout, provider error, malformed
response, or empty response is retained as `unknown` and does not trigger a
blind retry. An `unknown` session must be reconciled before another send.

The provider URL defaults to `http://127.0.0.1:17841` and can be changed with
`WEBCODEX_CHATGPT_WEB_URL`; the model defaults to `chatgpt-web/medium` and can
be changed with `WEBCODEX_CHATGPT_WEB_MODEL`. If the adapter expects a bearer
token, set `WEBCODEX_CHATGPT_WEB_TOKEN`; it is read for the request and never
stored or logged.

The default provider reuses the signed-in Ego Browser TaskSpace configured by
`scripts/webcodex-chat-runtime.sh setup`. Set
`WEBCODEX_CHATGPT_WEB_PROVIDER=codex-chatgpt-web` only to use the vendored
adapter fallback.

The two project fields have separate ownership rules:

- `project` is the required WebCodex local project binding. It is validated
  against the caller-visible Runner registry and controls local tool access.
- `web_project_url` is optional. It must be an exact HTTPS ChatGPT Project home
  URL ending in `/project` (for example,
  `https://chatgpt.com/g/g-p-<id>-<slug>/project`). On the first `send`, the
  Ego provider opens that Project home and submits the prompt; ChatGPT creates
  the native `/c/<chat-id>` conversation there. Later sends reuse the same
  browser page/session and must keep the same URL.

If `web_project_url` is omitted, the first send opens `https://chatgpt.com/` and
creates a normal non-Project Chat. Creating a WebCodex session alone does not
create a native ChatGPT Chat, and an arbitrary pre-existing ChatGPT conversation
cannot be adopted after the fact. Automatic background re-entry into a finished
ChatGPT turn remains provider/host dependent; the durable operation record is
the source of truth for recovery.
