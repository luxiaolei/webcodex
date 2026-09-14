#!/usr/bin/env node

// WebCodex control-plane relay. Ego Browser is the browser adapter; this file
// owns routing, durable checkpoints, idempotency, and controller replies.
// ponytail: one profile worker serializes its targets; add leases only when a
// measured deployment needs parallel target throughput.

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { parseRouteWithFallback } from "./webcodex-route.mjs";

const defaultApi = "http://127.0.0.1:8080";
const defaultProvider = "http://127.0.0.1:17841";
const maxMessageChars = 32_768;
const maxWaitMs = 180_000;
const defaultPollMs = 5_000;
const defaultMinSendIntervalMs = 15_000;
const defaultRateLimitBackoffMs = 30_000;
const defaultLocalRunnerWaitMs = 3_600_000;
const maxRateLimitBackoffMs = 300_000;

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

class RateLimitError extends Error {
  constructor(message, retryAfterMs, safeToRetry = false) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.safeToRetry = safeToRetry;
  }
}

class ChatOperationUnknownError extends Error {
  constructor(message, operationId) {
    super(message);
    this.name = "ChatOperationUnknownError";
    this.operationId = operationId;
  }
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function loadConfig(path) {
  const config = readJson(path, null);
  if (!config || typeof config !== "object") throw new Error(`relay config is not valid JSON: ${path}`);
  if (!/^[A-Za-z0-9_.-]+$/.test(String(config.profile || ""))) throw new Error("relay profile must contain only letters, digits, '.', '_' or '-'");
  if (!/^wc_chat_[A-Za-z0-9]+$/.test(String(config.controller_session || ""))) throw new Error("controller_session must be a WebCodex chat session id");
  if (!config.targets || typeof config.targets !== "object" || Array.isArray(config.targets)) throw new Error("relay targets must be an object");
  for (const [alias, sessionId] of Object.entries(config.targets)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(alias) || !/^wc_chat_[A-Za-z0-9]+$/.test(String(sessionId))) throw new Error(`invalid target ${alias}`);
  }
  const aliases = config.aliases && typeof config.aliases === "object" && !Array.isArray(config.aliases)
    ? config.aliases
    : {};
  return {
    api_url: String(config.api_url || process.env.WEBCODEX_URL || defaultApi).replace(/\/$/, ""),
    provider_url: String(config.provider_url || process.env.WEBCODEX_CHATGPT_WEB_URL || defaultProvider).replace(/\/$/, ""),
    token: process.env.WEBCODEX_TOKEN || "",
    profile: config.profile,
    project: typeof config.project === "string" && config.project.trim() ? config.project.trim() : undefined,
    controller_session: config.controller_session,
    targets: config.targets,
    aliases,
    poll_ms: boundedNumber(config.poll_ms ?? defaultPollMs, defaultPollMs, 1_000, 60_000),
    min_send_interval_ms: boundedNumber(config.min_send_interval_ms ?? defaultMinSendIntervalMs, defaultMinSendIntervalMs, 0, 300_000),
    rate_limit_backoff_ms: boundedNumber(config.rate_limit_backoff_ms ?? defaultRateLimitBackoffMs, defaultRateLimitBackoffMs, 1_000, maxRateLimitBackoffMs),
    local_runner_mode: config.local_runner_mode === "read_only" ? "read_only" : "normal",
    local_runner_sandbox: config.local_runner_sandbox === "read-only" ? "read-only" : "workspace-write",
    local_runner_timeout_secs: boundedNumber(config.local_runner_timeout_secs ?? 120, 120, 1, 120),
    local_runner_max_wait_ms: boundedNumber(config.local_runner_max_wait_ms ?? defaultLocalRunnerWaitMs, defaultLocalRunnerWaitMs, 5_000, 7_200_000),
    route_repair_command: typeof config.route_repair_command === "string" && config.route_repair_command.trim()
      ? config.route_repair_command.trim()
      : undefined,
    route_repair_cwd: typeof config.route_repair_cwd === "string" && config.route_repair_cwd.trim()
      ? config.route_repair_cwd.trim()
      : undefined,
    route_repair_timeout_ms: boundedNumber(config.route_repair_timeout_ms ?? 30_000, 30_000, 5_000, 120_000),
  };
}

function statePath(config) {
  const root = resolve(process.env.WEBCODEX_RUNTIME_HOME || `${process.env.HOME}/.config/webcodex`);
  return `${root}/relay/${config.profile}.json`;
}

function loadState(path, config) {
  const state = readJson(path, {});
  return {
    version: 1,
    profile: config.profile,
    controller_cursor: state.controller_cursor || null,
    ignored_message_ids: Array.isArray(state.ignored_message_ids) ? state.ignored_message_ids : [],
    events: state.events && typeof state.events === "object" ? state.events : {},
    next_send_at: Number.isFinite(state.next_send_at) ? state.next_send_at : 0,
    updated_at: state.updated_at || null,
  };
}

function saveState(path, state) {
  state.updated_at = new Date().toISOString();
  writeJson(path, state);
}

function directive(body, targets, aliases = {}) {
  const explicit = body.match(/(?:^|\n)\s*\[to:([A-Za-z0-9_.-]+)\]/i);
  let alias = explicit?.[1] || null;
  if (!alias) {
    const natural = body.match(/(?:转发|发送|发)\s*给\s*[“"'「]?([^\n\]】”"'」]+)[”"'」]?/i)
      || body.match(/(?:forward|send)\s+to\s+([A-Za-z0-9_.-]+)/i);
    const label = natural?.[1]?.trim();
    if (label) {
      alias = Object.keys(targets).find((candidate) => candidate === label
        || (Array.isArray(aliases[candidate]) && aliases[candidate].some((value) => value === label))) || null;
    }
  }
  if (!alias) return null;
  const sessionId = targets[alias];
  if (!sessionId) throw new Error(`unknown relay target '${alias}'`);
  return { alias, sessionId };
}

function messageKey(message) {
  return message.message_id || `${message.role}:${message.text}`;
}

function looksStructured(text) {
  const value = String(text || "").trim();
  return value.startsWith("{") || /^```(?:json)?\s*\n/i.test(value);
}

async function routeFromBody(body, config) {
  const explicit = directive(body, config.targets, config.aliases);
  if (explicit) return { ...explicit, kind: "web_chat", body, route_source: "explicit_directive" };
  if (!looksStructured(body)) return null;
  const options = {
    cwd: config.route_repair_cwd || process.cwd(),
    command: config.route_repair_command,
    timeoutMs: config.route_repair_timeout_ms,
  };
  if (typeof config.route_repair_runner === "function") options.runFallback = config.route_repair_runner;
  const parsed = await parseRouteWithFallback(body, options);
  if (parsed.route.destination.kind === "local_runner") {
    if (!config.project) throw new Error("local_runner route requires relay config project");
    if (parsed.route.destination.project !== config.project) {
      throw new Error(`local_runner route project '${parsed.route.destination.project}' is not bound to this relay profile`);
    }
    return {
      kind: "local_runner",
      project: parsed.route.destination.project,
      body: parsed.route.prompt,
      acceptance: parsed.route.acceptance,
      mode: parsed.route.mode,
      route_source: parsed.source,
    };
  }
  const alias = parsed.route.destination.alias;
  const sessionId = config.targets[alias];
  if (!sessionId) throw new Error(`unknown relay target '${alias}'`);
  return { kind: "web_chat", alias, sessionId, body: parsed.route.prompt, route_source: parsed.source };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    if (response.status === 429 || body?.error?.code === "preflight_rate_limited") {
      const retryAfterMs = Number(body?.error?.retry_after_ms)
        || Number(response.headers.get("retry-after")) * 1_000
        || defaultRateLimitBackoffMs;
      throw new RateLimitError(
        `${response.status} ${body?.error?.message || body?.message || "rate limited"}`,
        retryAfterMs,
        body?.error?.code === "preflight_rate_limited",
      );
    }
    throw new Error(`${response.status} ${body?.error?.message || body?.message || response.statusText}`);
  }
  return body;
}

function headers(config) {
  const value = { "content-type": "application/json" };
  if (config.token) value.authorization = `Bearer ${config.token}`;
  return value;
}

async function observe(config) {
  return requestJson(`${config.provider_url}/v1/sessions/${config.controller_session}/messages`, { headers: headers(config) });
}

async function controllerReplyVisible(config, reply) {
  try {
    const observed = await observe(config);
    return (observed.messages || []).some((message) => String(message.text || message.body || "") === reply);
  } catch {
    return false;
  }
}

async function waitForSendWindow(config, state, path) {
  const delay = state.next_send_at - Date.now();
  if (delay > 0) await sleep(delay);
  state.next_send_at = Date.now() + (Number.isFinite(config.min_send_interval_ms) ? config.min_send_interval_ms : 0);
  saveState(path, state);
}

function operationError(operation) {
  return `${operation.error_kind || ""} ${operation.error_message || ""}`;
}

function rateLimitFromOperation(operation, config) {
  const text = operationError(operation);
  if (!/429|rate[_ -]?limit|too many requests|请求太快|请求过快/i.test(text)) return null;
  const safeToRetry = /preflight_rate_limited/i.test(text);
  return new RateLimitError(text || "Chat operation was rate limited", config.rate_limit_backoff_ms, safeToRetry);
}

function reusableSlotConflict(error) {
  return /409.*reusable writable workspace slot is occupied/i.test(String(error));
}

async function sendSession(config, state, path, sessionId, body, idempotencyKey) {
  await waitForSendWindow(config, state, path);
  const started = await requestJson(`${config.api_url}/api/chat/session`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ action: "send", session_id: sessionId, body, idempotency_key: idempotencyKey }),
  });
  if (started.state === "completed") return started.assistant_body || "";
  const operationId = started.operation_id;
  if (!operationId) throw new Error("Chat send did not return an operation_id");
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const operation = await requestJson(`${config.api_url}/api/chat/session`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ action: "operation", operation_id: operationId }),
    });
    if (operation.state === "completed") return operation.assistant_body || "";
    if (operation.state === "unknown") {
      throw new ChatOperationUnknownError(
        `Chat operation ${operation.state}: ${operation.error_message || operation.error_kind || "no detail"}`,
        operationId,
      );
    }
    if (operation.state === "failed") {
      const rateLimit = rateLimitFromOperation(operation, config);
      if (rateLimit) throw rateLimit;
      throw new Error(`Chat operation ${operation.state}: ${operation.error_message || operation.error_kind || "no detail"}`);
    }
    await sleep(1000);
  }
  throw new ChatOperationUnknownError("Chat operation wait exceeded 180 seconds; outcome is unknown", operationId);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function localRunnerCommand(config, prompt) {
  const sandbox = config.local_runner_sandbox || "workspace-write";
  return [
    "codex exec --ephemeral --skip-git-repo-check",
    `--sandbox ${sandbox}`,
    "--model gpt-6-astra",
    "-c model_reasoning_effort=medium",
    "--json --cd .",
    shellQuote(prompt),
  ].join(" ");
}

function localRunnerGoal(routed) {
  const acceptance = Array.isArray(routed.acceptance) && routed.acceptance.length
    ? `\n\nAcceptance criteria:\n${routed.acceptance.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `${routed.body}${acceptance}`;
}

function localRunnerTaskGoal(goal) {
  const limit = 3_000;
  if (Buffer.byteLength(goal, "utf8") <= limit) return goal;
  return `${Buffer.from(goal, "utf8").subarray(0, limit).toString("utf8")}\n\n[full prompt is submitted with the runner command]`;
}

function localRunnerOutput(execution) {
  const stdout = String(execution?.output_tail?.stdout || "");
  const messages = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (typeof value.output_text === "string") messages.push(value.output_text);
      if (typeof value.item?.text === "string" && /message/i.test(String(value.item?.type || ""))) messages.push(value.item.text);
      if (typeof value.text === "string" && /message/i.test(String(value.type || ""))) messages.push(value.text);
    } catch { /* raw command output is still a valid receipt */ }
  }
  return (messages.at(-1) || stdout).trim();
}

function connectorError(body, action) {
  if (body?.ok !== false) return null;
  return new Error(`${action} failed: ${body?.error?.code || "connector_error"}: ${body?.error?.message || "no detail"}`);
}

async function runLocalRunner(config, state, path, routed, event, key, attempt) {
  const goal = localRunnerGoal(routed);
  let taskId = event.local_task_id;
  if (!taskId) {
    const started = await requestJson(`${config.api_url}/api/connector/task/start`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ goal: localRunnerTaskGoal(goal), mode: config.local_runner_mode || "normal" }),
    });
    const startError = connectorError(started, "task_start");
    if (startError) throw startError;
    taskId = started.task_id;
    if (typeof taskId !== "string" || !/^wc_task_[A-Za-z0-9]+$/.test(taskId)) {
      throw new Error("task_start did not return a valid task_id");
    }
    event.local_task_id = taskId;
    event.local_run_id = started.run_id || null;
    saveState(path, state);
  }
  const operationId = event.local_operation_id || `${config.profile}:${key}:local:${attempt}`;
  if (!event.local_operation_id) {
    event.local_operation_id = operationId;
    saveState(path, state);
  }
  const command = localRunnerCommand(config, goal);
  const submitted = await requestJson(`${config.api_url}/api/connector/commands/run`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      task_id: taskId,
      operation_id: operationId,
      command,
      timeout_secs: config.local_runner_timeout_secs || 120,
    }),
  });
  const submitError = connectorError(submitted, "commands_run");
  if (submitError) throw submitError;
  let current = submitted;
  const maxWaitMs = config.local_runner_max_wait_ms || defaultLocalRunnerWaitMs;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const execution = current?.data?.execution || current?.data?.recent_execution;
    const status = execution?.execution_status;
    if (status === "succeeded") {
      if (current?.data?.changes?.clean === true) {
        try {
          const cancelled = await requestJson(`${config.api_url}/api/connector/task/cancel`, {
            method: "POST",
            headers: headers(config),
            body: JSON.stringify({ task_id: taskId, reason: "execution completed with a clean workspace" }),
          });
          const cancelError = connectorError(cancelled, "task_cancel");
          if (cancelError) throw cancelError;
          event.local_task_status = "cancelled";
        } catch (error) {
          event.local_task_cleanup_error = String(error);
        }
        saveState(path, state);
      }
      return localRunnerOutput(execution) || `local task ${taskId} completed`;
    }
    if (["failed", "cancelled", "interrupted", "unknown"].includes(status)) {
      const detail = execution?.output_tail?.stderr || execution?.terminal_reason || status;
      throw new Error(`local runner execution ${status}: ${detail}`);
    }
    await sleep(Math.min(15_000, Math.max(1_000, config.poll_ms)));
    current = await requestJson(`${config.api_url}/api/connector/task/review`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({ task_id: taskId, wait_ms: Math.min(15_000, Math.max(1_000, config.poll_ms)), max_events: 50, include_output_tail: true }),
    });
    const reviewError = connectorError(current, "task_review");
    if (reviewError) throw reviewError;
  }
  throw new Error(`local runner task ${taskId} exceeded ${maxWaitMs}ms; outcome is unknown`);
}

function thinkingFailed(text) {
  return /thinking failed|思考失败/i.test(text || "");
}

async function processMessage(config, state, message, path) {
  const key = messageKey(message);
  const existing = state.events[key];
  const retryable = existing && (existing.state === "rate_limited" || existing.state === "reply_rate_limited")
    && Number(existing.retry_at || 0) <= Date.now();
  const slotRetryable = existing && existing.state === "unknown" && !existing.local_task_id
    && reusableSlotConflict(existing.error) && Number(existing.retry_at || 0) <= Date.now();
  const resumable = existing && existing.state === "forwarding";
  if (existing && !retryable && !slotRetryable && !resumable) return;
  if (message.role !== "user" && message.role !== "assistant") {
    if (existing) return;
    state.ignored_message_ids.push(key);
    saveState(path, state);
    return;
  }
  let routed;
  try { routed = await routeFromBody(message.text, config); } catch (error) {
    state.events[key] = { state: "rejected", source_message_id: key, source_body: message.text, error: String(error), updated_at: new Date().toISOString() };
    saveState(path, state);
    return;
  }
  if (!routed) {
    state.events[key] = { state: "unrouted", source_message_id: key, source_body: message.text, updated_at: new Date().toISOString() };
    saveState(path, state);
    return;
  }
  const event = existing || (state.events[key] = {
    state: "forwarding",
    source_message_id: key,
    source_body: message.text,
    target_kind: routed.kind,
    target_alias: routed.alias || "LOCAL_RUNNER",
    target_session_id: routed.sessionId || null,
    target_project: routed.project || null,
    route_source: routed.route_source,
    attempts: 0,
    updated_at: new Date().toISOString(),
  });
  saveState(path, state);
  try {
    const attempt = Number(event.attempts || 0) + 1;
    event.attempts = attempt;
    let result;
    if (event.state === "reply_rate_limited" && event.result_body) {
      result = event.result_body;
    } else if (routed.kind === "local_runner") {
      result = await runLocalRunner(config, state, path, routed, event, key, attempt);
    } else {
      const suffix = attempt > 1 ? `:retry:${attempt}` : "";
      result = await sendSession(config, state, path, routed.sessionId, routed.body, `${config.profile}:${key}:forward${suffix}`);
    }
    event.retried = false;
    if (routed.kind === "web_chat" && thinkingFailed(result)) {
      event.retried = true;
      result = await sendSession(config, state, path, routed.sessionId, "continue", `${config.profile}:${key}:continue:${attempt}`);
    }
    event.state = "forwarded";
    event.result_body = result;
    event.updated_at = new Date().toISOString();
    saveState(path, state);
    const reply = `[from:${routed.alias || "LOCAL_RUNNER"}]\n${result}`.slice(0, maxMessageChars);
    try {
      await sendSession(config, state, path, config.controller_session, reply, `${config.profile}:${key}:reply:${attempt}`);
      event.state = "replied";
      delete event.retry_at;
      event.updated_at = new Date().toISOString();
      saveState(path, state);
    } catch (error) {
      if (error instanceof ChatOperationUnknownError) {
        event.reply_operation_id = error.operationId;
        if (await controllerReplyVisible(config, reply)) {
          event.state = "replied";
          event.reply_recovered = true;
          event.updated_at = new Date().toISOString();
          saveState(path, state);
          return;
        }
      }
      event.state = error instanceof RateLimitError && error.safeToRetry ? "reply_rate_limited" : "reply_unknown";
      event.error = String(error);
      if (event.state === "reply_rate_limited") event.retry_at = Date.now() + error.retryAfterMs;
      event.updated_at = new Date().toISOString();
      saveState(path, state);
    }
  } catch (error) {
    if (error instanceof RateLimitError && error.safeToRetry) {
      event.state = "rate_limited";
      event.retry_at = Date.now() + error.retryAfterMs;
    } else if (reusableSlotConflict(error)) {
      event.state = "unknown";
      event.retry_at = Date.now() + config.rate_limit_backoff_ms;
    } else {
      event.state = "unknown";
    }
    event.error = String(error);
    event.updated_at = new Date().toISOString();
    saveState(path, state);
  }
}

async function runOnce(config, state, path) {
  const observed = await observe(config);
  for (const message of observed.messages || []) {
    const key = messageKey(message);
    if (state.ignored_message_ids.includes(key)) continue;
    await processMessage(config, state, message, path);
    state.controller_cursor = key;
    saveState(path, state);
  }
  return state;
}

async function run(configPath, once = false) {
  const config = loadConfig(configPath);
  const path = statePath(config);
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = openSync(lockPath, "wx", 0o600); } catch { throw new Error(`relay profile '${config.profile}' is already running`); }
  try {
    const state = loadState(path, config);
    do {
      await runOnce(config, state, path);
      if (!once) await sleep(config.poll_ms);
    } while (!once);
    return state;
  } finally {
    closeSync(lock);
    try { unlinkSync(lockPath); } catch { }
  }
}

function usage() {
  return "usage: webcodex-relay.mjs --config <profile.json> [--once]";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : process.env.WEBCODEX_RELAY_CONFIG;
  if (!configPath) { console.error(usage()); process.exit(2); }
  try {
    const state = await run(configPath, process.argv.includes("--once"));
    if (process.argv.includes("--once")) process.stdout.write(`${JSON.stringify(state)}\n`);
  } catch (error) {
    console.error(`webcodex-relay: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

export { directive, loadConfig, processMessage, runOnce };
