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
The provider URL, browser TaskSpace, model, and account settings are global
runtime settings. A project never needs a provider edit or a second login.

The vendored adapter remains available for hosts without Ego Browser by setting
`WEBCODEX_CHATGPT_WEB_PROVIDER=codex-chatgpt-web` before `setup` and `start`.

Each caller selects an exact visible WebCodex Project in
`POST /api/chat/session`; this is request data, not project configuration. The
same runtime can therefore serve multiple projects and multiple durable Chat
sessions while preserving project-scoped tool permissions.

The setup command is intentionally one-time and account-scoped. It does not
claim native ChatGPT Project membership or make arbitrary existing ChatGPT
conversations adoptable. The provider must still report a healthy browser
session before a ChatGPT turn is considered runnable.

The local-tool hop is the WebCodex MCP endpoint, not a second ChatGPT Web
provider. A ChatGPT Work task reaches that endpoint through the configured MCP
app and can run `task_start(mode=read_only)` followed by `files_list` with the
returned task id. This keeps the two runtime paths reusable: the Ego-backed
provider handles ChatGPT Web turns started by `/api/chat/session`, while the
MCP app handles ChatGPT-to-local tools. See the [MCP Work-surface smoke test](MCP.md#chatgpt-work-surface-smoke-test)
for the end-to-end check.
