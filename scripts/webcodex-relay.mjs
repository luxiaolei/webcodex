#!/usr/bin/env node

// WebCodex control-plane relay. Ego Browser is the browser adapter; this file
// owns routing, durable checkpoints, idempotency, and controller replies.
// ponytail: one profile worker serializes its targets; add leases only when a
// measured deployment needs parallel target throughput.

import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const defaultApi = "http://127.0.0.1:8080";
const defaultProvider = "http://127.0.0.1:17841";
const maxMessageChars = 32_768;
const maxWaitMs = 180_000;
const defaultPollMs = 5_000;
const defaultMinSendIntervalMs = 15_000;
const defaultRateLimitBackoffMs = 30_000;
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
    controller_session: config.controller_session,
    targets: config.targets,
    aliases,
    poll_ms: boundedNumber(config.poll_ms ?? defaultPollMs, defaultPollMs, 1_000, 60_000),
    min_send_interval_ms: boundedNumber(config.min_send_interval_ms ?? defaultMinSendIntervalMs, defaultMinSendIntervalMs, 0, 300_000),
    rate_limit_backoff_ms: boundedNumber(config.rate_limit_backoff_ms ?? defaultRateLimitBackoffMs, defaultRateLimitBackoffMs, 1_000, maxRateLimitBackoffMs),
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
    if (operation.state === "failed" || operation.state === "unknown") {
      const rateLimit = rateLimitFromOperation(operation, config);
      if (rateLimit) throw rateLimit;
      throw new Error(`Chat operation ${operation.state}: ${operation.error_message || operation.error_kind || "no detail"}`);
    }
    await sleep(1000);
  }
  throw new Error("Chat operation wait exceeded 180 seconds; outcome is unknown");
}

function thinkingFailed(text) {
  return /thinking failed|思考失败/i.test(text || "");
}

async function processMessage(config, state, message, path) {
  const key = messageKey(message);
  const existing = state.events[key];
  const retryable = existing && (existing.state === "rate_limited" || existing.state === "reply_rate_limited")
    && Number(existing.retry_at || 0) <= Date.now();
  if (existing && !retryable) return;
  if (message.role !== "user") {
    if (existing) return;
    state.ignored_message_ids.push(key);
    saveState(path, state);
    return;
  }
  let route;
  try { route = directive(message.text, config.targets, config.aliases); } catch (error) {
    state.events[key] = { state: "rejected", source_message_id: key, source_body: message.text, error: String(error), updated_at: new Date().toISOString() };
    saveState(path, state);
    return;
  }
  if (!route) {
    state.events[key] = { state: "unrouted", source_message_id: key, source_body: message.text, updated_at: new Date().toISOString() };
    saveState(path, state);
    return;
  }
  const event = existing || (state.events[key] = {
    state: "forwarding",
    source_message_id: key,
    source_body: message.text,
    target_alias: route.alias,
    target_session_id: route.sessionId,
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
    } else {
      const suffix = attempt > 1 ? `:retry:${attempt}` : "";
      result = await sendSession(config, state, path, route.sessionId, message.text, `${config.profile}:${key}:forward${suffix}`);
    }
    event.retried = false;
    if (thinkingFailed(result)) {
      event.retried = true;
      result = await sendSession(config, state, path, route.sessionId, "continue", `${config.profile}:${key}:continue:${attempt}`);
    }
    event.state = "forwarded";
    event.result_body = result;
    event.updated_at = new Date().toISOString();
    saveState(path, state);
    const reply = `[from:${route.alias}]\n${result}`.slice(0, maxMessageChars);
    try {
      await sendSession(config, state, path, config.controller_session, reply, `${config.profile}:${key}:reply:${attempt}`);
      event.state = "replied";
      delete event.retry_at;
      event.updated_at = new Date().toISOString();
      saveState(path, state);
    } catch (error) {
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
