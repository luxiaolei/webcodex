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

async function api(apiUrl, token, payload) {
  const response = await fetch(`${apiUrl}/api/chat/session`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${body?.message || body?.error_kind || response.statusText}`);
  return body;
}

async function send(apiUrl, token, sessionId, body, key) {
  const started = await api(apiUrl, token, { action: "send", session_id: sessionId, body, idempotency_key: key });
  if (started.state === "completed") return;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const operation = await api(apiUrl, token, { action: "operation", operation_id: started.operation_id });
    if (operation.state === "completed") return;
    if (operation.state === "failed" || operation.state === "unknown") throw new Error(operation.error_message || operation.error_kind || operation.state);
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
  provider_url: input.provider_url,
  poll_ms: input.poll_ms ?? 5000,
  min_send_interval_ms: input.min_send_interval_ms ?? 15000,
  rate_limit_backoff_ms: input.rate_limit_backoff_ms ?? 30000,
  aliases: input.aliases || {},
  controller_session: await create(apiUrl, token, input.project, input.controller, `${input.profile}:controller:create`),
  targets: {},
};
await send(apiUrl, token, output.controller_session, input.controller.bootstrap || "你是 WebCodex 项目的总控。需要转发任务时，必须在消息中使用 [to:目标别名] 标记；保留任务原文，等待目标回执后继续推进。", `${input.profile}:controller:bootstrap`);
for (const [alias, spec] of Object.entries(input.targets)) {
  output.targets[alias] = await create(apiUrl, token, input.project, spec, `${input.profile}:${alias}:create`);
  await send(apiUrl, token, output.targets[alias], spec.bootstrap || `你是 ${alias} 目标会话。处理收到的原文，完成后返回可直接回贴总控的结果。`, `${input.profile}:${alias}:bootstrap`);
}
save(path, output);
process.stdout.write(`${JSON.stringify({ profile: output.profile, controller_session: output.controller_session, targets: output.targets })}\n`);
