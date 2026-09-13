# Unified Chat runtime

WebCodex uses the signed-in Ego Browser as its default ChatGPT Web provider and
keeps the runtime portion of `codex-chatgpt-web` under
`vendor/codex-chatgpt-web` as an explicit fallback. The two responsibilities
stay explicit inside one repository and one user-facing runtime:

- WebCodex owns Projects, local tools, durable Chat sessions, operations, and
  recovery state.
- Ego Browser owns the browser-backed ChatGPT Web provider.

Run `scripts/webcodex-chat-runtime.sh setup` once for the machine/account. It
uses the signed-in Ego Browser profile and stores only the selected numeric
TaskSpace id under `$XDG_CONFIG_HOME/webcodex/ego` (or
`~/.config/webcodex/ego`); it does not copy browser cookies or create a second
login. Set `WEBCODEX_EGO_SPACE_ID` to reuse an existing TaskSpace; when it is
omitted, setup creates a dedicated `WebCodex Runtime` TaskSpace in that same
Ego profile. Then run `scripts/webcodex-chat-runtime.sh start` to start
WebCodex and reuse the loopback Ego provider.
The provider URL, browser account, and model settings are global runtime
settings. TaskSpace selection is explicit per local Project: one Project maps
to one existing Ego TaskSpace, while the same provider process can serve all
of those spaces. Keep the mapping in the private
`$XDG_CONFIG_HOME/webcodex/ego/project-spaces.json` file:

```json
{
  "projects": {
    "<quantcompany WebCodex project id>": 2,
    "<hz-os WebCodex project id>": 1
  }
}
```

An unknown Project fails closed when an explicit mapping exists. Space 3 may be
used for development checks, but it is not a business Project route.

The vendored adapter remains available for hosts without Ego Browser by setting
`WEBCODEX_CHATGPT_WEB_PROVIDER=codex-chatgpt-web` before `setup` and `start`.

Each caller selects an exact visible WebCodex Project in
`POST /api/chat/session`; this is request data, not project configuration. The
optional `web_project_url` selects the native ChatGPT Project home used on the
first browser send. The same runtime can therefore serve multiple local
projects and multiple durable Chat sessions while preserving project-scoped
tool permissions; the browser account is shared, but the TaskSpace is selected
from the Project mapping before every browser operation.

The setup command is intentionally one-time and account-scoped. A native
ChatGPT Project is selected per session with `web_project_url`; the URL is
validated and persisted with the session, then reused on every send. Omitting
it creates a regular ChatGPT Chat. The runtime does not make arbitrary existing
ChatGPT conversations adoptable. The provider must still report a healthy
browser session before a ChatGPT turn is considered runnable.

The local-tool hop is the WebCodex MCP endpoint, not a second ChatGPT Web
provider. A ChatGPT Work task reaches that endpoint through the configured MCP
app and can run `task_start(mode=read_only)` followed by `files_list` with the
returned task id. This keeps the two runtime paths reusable: the Ego-backed
provider handles ChatGPT Web turns started by `/api/chat/session`, while the
MCP app handles ChatGPT-to-local tools. See the [MCP Work-surface smoke test](MCP.md#chatgpt-work-surface-smoke-test)
for the end-to-end check.
