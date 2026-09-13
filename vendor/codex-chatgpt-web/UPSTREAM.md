# Embedded ChatGPT Web adapter

This directory is the runtime portion of [`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web), embedded so WebCodex can ship one local ChatGPT-to-tools runtime.

- Upstream revision: `e85e3693fdb4e3e033348c08df0298c20fcdb612`
- License: MIT (see `LICENSE`)
- Runtime ownership: WebCodex owns the outer Project, session, tool, and operation state. This package owns the browser-backed ChatGPT Web provider.

The embedded package is intentionally configured by the unified WebCodex launcher. Do not add project-specific settings here; account, browser, and provider settings belong to the single global runtime profile.

The desktop launcher assets and release scripts are not vendored. The package
typecheck therefore covers the embedded `src/` runtime; the copied upstream
tests remain available for adapter-level regression checks.
