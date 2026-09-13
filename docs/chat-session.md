# Chat session bridge

WebCodex exposes one authenticated GPT Actions/MCP-compatible endpoint:
`POST /api/chat/session`. It keeps a caller-owned session bound to an exact
Runner Project, starts a ChatGPT Web Responses turn through the local
`codex-chatgpt-web` adapter, and retains messages and operation state in the
WebCodex SQLite store.

The request uses one of four actions:

```json
{"action":"create","title":"Research","project":"runner/project","idempotency_key":"create-1"}
{"action":"send","session_id":"wc_chat_...","body":"Run the small calculation","idempotency_key":"send-1"}
{"action":"operation","operation_id":"wc_chat_op_..."}
{"action":"read","session_id":"wc_chat_...","after_seq":0,"limit":100}
```

`send` returns `202` with an operation id. The operation transitions to
`completed`, `failed`, or `unknown`; a request timeout, provider error, malformed
response, or empty response is retained as `unknown` and does not trigger a
blind retry. An `unknown` session must be reconciled before another send.

The adapter URL defaults to `http://127.0.0.1:17841` and can be changed with
`WEBCODEX_CHATGPT_WEB_URL`; the model defaults to `chatgpt-web/medium` and can
be changed with `WEBCODEX_CHATGPT_WEB_MODEL`. If the adapter expects a bearer
token, set `WEBCODEX_CHATGPT_WEB_TOKEN`; it is read for the request and never
stored or logged.

The `project` field is the WebCodex local project binding. It is validated
against the caller-visible Runner registry. It does not assert membership in a
native ChatGPT Project, and it does not claim that an arbitrary pre-existing
ChatGPT conversation can be adopted. Automatic background re-entry into a
finished ChatGPT turn remains adapter/host dependent; the durable operation
record is the source of truth for recovery.
