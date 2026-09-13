# Unified Chat runtime

WebCodex now ships the runtime portion of `codex-chatgpt-web` under
`vendor/codex-chatgpt-web`. The two responsibilities stay explicit inside one
repository and one user-facing runtime:

- WebCodex owns Projects, local tools, durable Chat sessions, operations, and
  recovery state.
- The embedded adapter owns the browser-backed ChatGPT Web provider.

Run `scripts/webcodex-chat-runtime.sh setup` once for the machine/account. The
profile is stored outside the repository under
`$XDG_CONFIG_HOME/webcodex/chatgpt-web` (or `~/.config/webcodex/chatgpt-web`).
Then run `scripts/webcodex-chat-runtime.sh start` to supervise both processes.
The adapter URL, browser profile, model, and account settings are global
runtime settings. A project never needs an adapter edit or a second login.

Each caller selects an exact visible WebCodex Project in
`POST /api/chat/session`; this is request data, not project configuration. The
same runtime can therefore serve multiple projects and multiple durable Chat
sessions while preserving project-scoped tool permissions.

The setup command is intentionally one-time and account-scoped. It does not
claim native ChatGPT Project membership or make arbitrary existing ChatGPT
conversations adoptable. The adapter must still report a healthy provider
before a ChatGPT turn is considered runnable.
