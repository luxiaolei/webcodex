#!/usr/bin/env bash
set -euo pipefail

# One global runtime: WebCodex owns projects/tools; Ego Browser owns ChatGPT Web.
# Project selection stays in POST /api/chat/session and never changes this profile.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADAPTER_ROOT="${WEBCODEX_CHATGPT_WEB_ROOT:-$ROOT/vendor/codex-chatgpt-web}"
CONFIG_ROOT="${WEBCODEX_RUNTIME_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/webcodex}"
CHAT_HOME="${CODEX_CHATGPT_WEB_HOME:-$CONFIG_ROOT/chatgpt-web}"
EGO_PROVIDER_SCRIPT="$ROOT/scripts/ego-chatgpt-web-provider.mjs"
LOG_ROOT="${WEBCODEX_CHAT_LOG_HOME:-$CONFIG_ROOT/logs}"
ADAPTER_PORT="${WEBCODEX_CHATGPT_WEB_PORT:-17841}"
ADAPTER_URL="${WEBCODEX_CHATGPT_WEB_URL:-http://127.0.0.1:${ADAPTER_PORT}}"
ADAPTER_LOG="$LOG_ROOT/chatgpt-web.log"
PROVIDER="${WEBCODEX_CHATGPT_WEB_PROVIDER:-ego-browser}"

die() { printf 'webcodex-chat-runtime: %s\n' "$*" >&2; exit 2; }

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1";
}

ensure_adapter_dependencies() {
  need_command bun
  if [[ ! -d "$ADAPTER_ROOT/node_modules" ]]; then
    bun install --frozen-lockfile --cwd "$ADAPTER_ROOT"
  fi
}

adapter_config="$CHAT_HOME/config.json"

run_ego_provider() {
  need_command ego-browser
  need_command python3
  local mode="$1"
  local root_json port_json space_json mode_json
  root_json="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$CONFIG_ROOT")"
  port_json="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$ADAPTER_PORT")"
  space_json="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${WEBCODEX_EGO_SPACE_ID:-}")"
  mode_json="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$mode")"
  WEBCODEX_RUNTIME_HOME="$CONFIG_ROOT" \
    WEBCODEX_CHATGPT_WEB_PORT="$ADAPTER_PORT" \
    WEBCODEX_EGO_SPACE_ID="${WEBCODEX_EGO_SPACE_ID:-}" \
    WEBCODEX_EGO_PROVIDER_MODE="$mode" \
    ego-browser nodejs -e "globalThis.__WEBCODEX_PROVIDER_CONFIG={root:${root_json},port:${port_json},spaceId:${space_json},mode:${mode_json}}; await import('file://${EGO_PROVIDER_SCRIPT}')"
}

case "${1:-status}" in
  status)
    if [[ "$PROVIDER" == "ego-browser" ]]; then
      run_ego_provider status
      exit 0
    fi
    if [[ ! -f "$adapter_config" ]]; then
      printf 'configured=false\nchat_home=%s\nadapter_url=%s\n' "$CHAT_HOME" "$ADAPTER_URL"
      exit 0
    fi
    ensure_adapter_dependencies
    CODEX_CHATGPT_WEB_HOME="$CHAT_HOME" bun run --cwd "$ADAPTER_ROOT" src/cli.ts doctor --json
    ;;
  setup)
    if [[ "$PROVIDER" == "ego-browser" ]]; then
      mkdir -p "$CONFIG_ROOT/ego" "$LOG_ROOT"
      run_ego_provider setup
      exit 0
    fi
    ensure_adapter_dependencies
    mkdir -p "$CHAT_HOME" "$LOG_ROOT"
    CODEX_CHATGPT_WEB_HOME="$CHAT_HOME" bun run --cwd "$ADAPTER_ROOT" src/cli.ts setup --browser-only --acknowledge-unofficial
    ;;
  start)
    if [[ "$PROVIDER" == "ego-browser" ]]; then
      [[ -f "$CONFIG_ROOT/ego/runtime.json" ]] || die "run '$0 setup' once for the shared Ego Browser session"
      mkdir -p "$LOG_ROOT"
      if ! curl -fsS "$ADAPTER_URL/healthz" >/dev/null 2>&1; then
        run_ego_provider serve >"$ADAPTER_LOG" 2>&1 &
        adapter_pid=$!
      else
        adapter_pid=''
      fi
      cleanup() {
        if [[ -n "$adapter_pid" ]]; then
          curl -fsS -X POST "$ADAPTER_URL/shutdown" >/dev/null 2>&1 || true
          kill "$adapter_pid" 2>/dev/null || true
          wait "$adapter_pid" 2>/dev/null || true
        fi
      }
      trap cleanup EXIT INT TERM
      for _ in {1..60}; do
        if curl -fsS "$ADAPTER_URL/healthz" >/dev/null 2>&1; then break; fi
        if [[ -n "$adapter_pid" ]] && ! kill -0 "$adapter_pid" 2>/dev/null; then
          sed -n '1,160p' "$ADAPTER_LOG" >&2 || true
          die "Ego Browser provider exited before becoming healthy"
        fi
        sleep 1
      done
      curl -fsS "$ADAPTER_URL/healthz" >/dev/null 2>&1 || die "Ego Browser provider did not become healthy"
      export WEBCODEX_CHATGPT_WEB_URL="$ADAPTER_URL"
      export WEBCODEX_CHATGPT_WEB_HOME="$CONFIG_ROOT/ego"
      if [[ -x "${WEBCODEX_SERVER_BIN:-$ROOT/target/debug/webcodex-server}" ]]; then
        "${WEBCODEX_SERVER_BIN:-$ROOT/target/debug/webcodex-server}"
        exit $?
      fi
      need_command cargo
      cargo run --bin webcodex-server
      exit $?
    fi
    [[ -f "$adapter_config" ]] || die "run '$0 setup' once for the shared ChatGPT Web profile"
    ensure_adapter_dependencies
    mkdir -p "$LOG_ROOT"
    adapter_pid=''
    if ! curl -fsS "$ADAPTER_URL/healthz" >/dev/null 2>&1; then
      CODEX_CHATGPT_WEB_HOME="$CHAT_HOME" bun run --cwd "$ADAPTER_ROOT" src/cli.ts serve >"$ADAPTER_LOG" 2>&1 &
      adapter_pid=$!
    fi
    cleanup() {
      if [[ -n "$adapter_pid" ]]; then
        kill "$adapter_pid" 2>/dev/null || true
        wait "$adapter_pid" 2>/dev/null || true
      fi
    }
    trap cleanup EXIT INT TERM
    for _ in {1..60}; do
      if curl -fsS "$ADAPTER_URL/healthz" >/dev/null 2>&1; then break; fi
      if ! kill -0 "$adapter_pid" 2>/dev/null; then
        sed -n '1,160p' "$ADAPTER_LOG" >&2 || true
        die "ChatGPT Web adapter exited before becoming healthy"
      fi
      sleep 1
    done
    curl -fsS "$ADAPTER_URL/healthz" >/dev/null 2>&1 || die "ChatGPT Web adapter did not become healthy"
    export WEBCODEX_CHATGPT_WEB_URL="$ADAPTER_URL"
    export WEBCODEX_CHATGPT_WEB_HOME="$CHAT_HOME"
    if [[ -x "${WEBCODEX_SERVER_BIN:-$ROOT/target/debug/webcodex-server}" ]]; then
      exec "${WEBCODEX_SERVER_BIN:-$ROOT/target/debug/webcodex-server}"
    fi
    need_command cargo
    exec cargo run --bin webcodex-server
    ;;
  *)
    die "usage: $0 {status|setup|start}"
    ;;
esac
