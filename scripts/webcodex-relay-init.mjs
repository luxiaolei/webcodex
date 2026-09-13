#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function save(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function headers(token) {
  const result = { "content-type": "application/json" };
  if (token) result.authorization = `Bearer ${token}`;
  return result;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class BootstrapRateLimitError extends Error {
  constructor(message, retryAfterMs, safeToRetry) {
    super(message);
    this.name = "BootstrapRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.safeToRetry = safeToRetry;
  }
}

async function api(apiUrl, token, payload) {
  const response = await fetch(`${apiUrl}/api/chat/session`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 429 || body?.error?.code === "preflight_rate_limited") {
      throw new BootstrapRateLimitError(
        `${response.status}: ${body?.error?.message || body?.message || response.statusText}`,
        Number(body?.error?.retry_after_ms) || Number(response.headers.get("retry-after")) * 1_000 || 30_000,
        body?.error?.code === "preflight_rate_limited",
      );
    }
    throw new Error(`${response.status}: ${body?.message || body?.error_kind || response.statusText}`);
  }
  return body;
}

async function send(apiUrl, token, sessionId, body, key) {
  const started = await api(apiUrl, token, { action: "send", session_id: sessionId, body, idempotency_key: key });
  if (started.state === "completed") return;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const operation = await api(apiUrl, token, { action: "operation", operation_id: started.operation_id });
    if (operation.state === "completed") return;
    if (operation.state === "failed" || operation.state === "unknown") {
      const detail = `${operation.error_kind || ""} ${operation.error_message || operation.state}`;
      if (/preflight_rate_limited/i.test(detail)) {
        throw new BootstrapRateLimitError(detail, Number(operation.retry_after_ms) || 30_000, true);
      }
      throw new Error(detail);
    }
    await sleep(1000);
  }
  throw new Error("bootstrap Chat operation exceeded 180 seconds");
}

async function create(apiUrl, token, project, spec, key) {
  const result = await api(apiUrl, token, {
    action: "create",
    title: spec.title,
    project,
    web_project_url: spec.web_project_url,
    idempotency_key: key,
  });
  return result.session.session_id;
}

async function createAndBootstrap(apiUrl, token, project, spec, key, bootstrapBody) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const suffix = attempt === 1 ? "" : `:retry:${attempt}`;
    const sessionId = await create(apiUrl, token, project, spec, `${key}:create${suffix}`);
    try {
      await send(apiUrl, token, sessionId, bootstrapBody, `${key}:bootstrap${suffix}`);
      return sessionId;
    } catch (error) {
      if (!(error instanceof BootstrapRateLimitError) || !error.safeToRetry || attempt === 3) throw error;
      await sleep(Math.max(30_000, error.retryAfterMs));
    }
  }
  throw new Error(`unable to bootstrap ${spec.title}`);
}

const configIndex = process.argv.indexOf("--config");
const path = (configIndex >= 0 ? process.argv[configIndex + 1] : null) || process.env.WEBCODEX_RELAY_CONFIG;
if (!path) throw new Error("usage: webcodex-relay-init.mjs --config <profile-bootstrap.json>");
const input = json(path);
const apiUrl = String(input.api_url || process.env.WEBCODEX_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const token = process.env.WEBCODEX_TOKEN || "";
if (!input.project || !input.controller?.title || !input.controller?.web_project_url) throw new Error("config requires project and controller title/web_project_url");
if (!input.targets || typeof input.targets !== "object") throw new Error("config requires targets");

const output = {
  profile: input.profile,
  api_url: apiUrl,
  project: input.project,
  provider_url: input.provider_url,
  poll_ms: input.poll_ms ?? 5000,
  min_send_interval_ms: input.min_send_interval_ms ?? 15000,
  rate_limit_backoff_ms: input.rate_limit_backoff_ms ?? 30000,
  aliases: input.aliases || {},
  controller_session: await createAndBootstrap(
    apiUrl,
    token,
    input.project,
    input.controller,
    `${input.profile}:controller`,
    input.controller.bootstrap || "你是 WebCodex 项目的总控。需要转发任务时，必须在消息中使用 [to:目标别名] 标记；保留任务原文，等待目标回执后继续推进。",
  ),
  targets: {},
};
for (const [alias, spec] of Object.entries(input.targets)) {
  output.targets[alias] = await createAndBootstrap(
    apiUrl,
    token,
    input.project,
    spec,
    `${input.profile}:${alias}`,
    spec.bootstrap || `你是 ${alias} 目标会话。处理收到的原文，完成后返回可直接回贴总控的结果。`,
  );
}
save(path, output);
process.stdout.write(`${JSON.stringify({ profile: output.profile, controller_session: output.controller_session, targets: output.targets })}\n`);
