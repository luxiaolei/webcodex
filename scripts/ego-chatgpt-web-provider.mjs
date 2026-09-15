import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const injected = globalThis.__WEBCODEX_PROVIDER_CONFIG || {};
const injectedTask = globalThis.__WEBCODEX_PROVIDER_TASK || null;
const root = resolve(injected.root || process.env.WEBCODEX_RUNTIME_HOME || `${process.env.HOME}/.config/webcodex`);
const port = Number(injected.port || process.env.WEBCODEX_CHATGPT_WEB_PORT || 17841);
const statePath = `${root}/ego/runtime.json`;
const sessionsPath = `${root}/ego/sessions.json`;
const projectSpacesPath = injected.projectSpacesPath || process.env.WEBCODEX_EGO_PROJECT_SPACES_FILE || `${root}/ego/project-spaces.json`;
const spaceIdFromEnv = String(injected.spaceId || process.env.WEBCODEX_EGO_SPACE_ID || "").trim();
const maxBodyBytes = 1_000_000;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const minSendIntervalMs = Math.max(0, finiteNumber(injected.minSendIntervalMs ?? process.env.WEBCODEX_CHATGPT_MIN_SEND_INTERVAL_MS, 15_000));
const rateLimitBaseMs = Math.max(1_000, finiteNumber(injected.rateLimitBaseMs ?? process.env.WEBCODEX_CHATGPT_RATE_LIMIT_BASE_MS, 30_000));
const rateLimitMaxMs = Math.max(rateLimitBaseMs, finiteNumber(injected.rateLimitMaxMs ?? process.env.WEBCODEX_CHATGPT_RATE_LIMIT_MAX_MS, 300_000));
let nextSendAt = 0;
let rateLimitStreak = 0;

class RateLimitError extends Error {
  constructor(message, retryAfterMs, safeToRetry) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.safeToRetry = safeToRetry;
  }
}

function isRateLimitedText(text) {
  return /too many requests|you(?:'|’)?re making requests too quickly|请求太快|请求过快|rate[_ -]?limit/i.test(text || "");
}

function rateLimitDelay(streak) {
  const exponent = Math.max(0, Math.min(8, Number(streak) - 1));
  return Math.min(rateLimitMaxMs, rateLimitBaseMs * (2 ** exponent));
}

async function pageHasRateLimit(page) {
  return page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')]
    .some((node) => /too many requests|you(?:'|’)?re making requests too quickly|请求太快|请求过快|rate[_ -]?limit/i.test(node.textContent || "")));
}

async function dismissRateLimitDialog(page) {
  if (!await pageHasRateLimit(page)) return;
  await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => /too many requests|you(?:'|’)?re making requests too quickly|请求太快|请求过快|rate[_ -]?limit/i.test(node.textContent || ""));
    const button = [...(dialog?.querySelectorAll("button") || [])]
      .find((node) => (node.textContent || "").trim() === "Got it");
    button?.click();
  });
}

async function waitForSendWindow() {
  const delay = nextSendAt - Date.now();
  if (delay > 0) await sleep(delay);
}

function markSendStarted() {
  nextSendAt = Date.now() + minSendIntervalMs;
}

function markSendSucceeded() {
  rateLimitStreak = 0;
}

function markRateLimited(safeToRetry) {
  rateLimitStreak += 1;
  const retryAfterMs = rateLimitDelay(rateLimitStreak);
  nextSendAt = Math.max(nextSendAt, Date.now() + retryAfterMs);
  return new RateLimitError("ChatGPT web rate limit is active", retryAfterMs, safeToRetry);
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function runtimeState() { return readJson(statePath, null); }
function sessionState() { return readJson(sessionsPath, {}); }

function projectSpaceConfig() {
  const value = readJson(projectSpacesPath, {});
  const projects = value && typeof value.projects === "object" && value.projects !== null ? value.projects : {};
  const defaultValue = Number(value?.default_space_id);
  return {
    projects,
    defaultSpaceId: Number.isInteger(defaultValue) && defaultValue >= 0 ? defaultValue : null,
  };
}

function configuredSpaceIds() {
  const ids = new Set();
  const config = projectSpaceConfig();
  for (const value of runtimeState()?.space_ids || []) {
    const id = Number(value);
    if (Number.isInteger(id) && id >= 0) ids.add(id);
  }
  for (const value of Object.values(config.projects)) {
    const id = Number(value);
    if (Number.isInteger(id) && id >= 0) ids.add(id);
  }
  if (config.defaultSpaceId !== null) ids.add(config.defaultSpaceId);
  const fallback = Number(spaceIdFromEnv || runtimeState()?.space_id);
  if (Number.isInteger(fallback) && fallback >= 0) ids.add(fallback);
  return [...ids].sort((a, b) => a - b);
}

function requireSpaceId() {
  const raw = spaceIdFromEnv || runtimeState()?.space_id;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Ego Browser TaskSpace is not configured; set WEBCODEX_EGO_SPACE_ID or run setup");
  }
  return value;
}

async function setupTask() {
  if (spaceIdFromEnv || runtimeState()?.space_id !== undefined) return openTaskSpace(requireSpaceId());
  return taskSpace("WebCodex Runtime");
}

async function runtimeTask() {
  return runtimeTaskForSpace(undefined);
}

async function runtimeTaskForSpace(spaceId) {
  const id = spaceId === undefined ? requireSpaceId() : spaceId;
  if (injectedTask && Number(injectedTask.spaceId) === Number(id)) return injectedTask;
  return openTaskSpace(id);
}

async function openTaskSpace(id) {
  try {
    return await taskSpace(id);
  } catch (error) {
    if (typeof claimTaskSpace !== "function") throw error;
    return claimTaskSpace(id);
  }
}

async function waitForComposer(page) {
  await page.waitForSelector("loc=css:#prompt-textarea", { timeout: 15_000 });
}

function completedTurn(input) {
  const { body, userMessageId } = typeof input === "string" ? { body: input } : input;
  const normalize = (value) => String(value || "").replace(/\s+/gu, " ").trim();
  if (document.querySelector('button[aria-label="Stop answering"], button[data-testid="stop-button"]')) return null;
  const nodes = [...document.querySelectorAll('[data-message-author-role], [data-turn="assistant"]')]
    .filter((node) => !(node.matches('[data-turn="assistant"]') && node.querySelector('[data-message-author-role]')));
  const matches = nodes.map((node, index) => ({ node, index }))
    .filter(({ node }) => node.getAttribute('data-message-author-role') === 'user'
      && (userMessageId ? node.getAttribute('data-message-id') === userMessageId : normalize(node.textContent) === normalize(body)));
  if (matches.length !== 1) return null;
  const node = nodes[matches[0].index + 1];
  if (!node || (node.getAttribute('data-message-author-role') || node.getAttribute('data-turn')) !== 'assistant') return null;
  const turn = node.closest('[data-turn="assistant"]');
  // Virtualized history can keep the same turn count while a new reply arrives.
  // Match the request and require the final-response actions, not a text preview.
  if (!turn?.querySelector('button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]')) return null;
  const text = node.textContent?.trim();
  if (!text) return null;
  return { text, messageId: node.getAttribute('data-message-id') || turn.getAttribute('data-turn-id') };
}

async function sessionMessages(page) {
  return page.evaluate(() => {
    const messages = [];
    for (const node of document.querySelectorAll('[data-message-author-role], [data-turn="assistant"]')) {
      if (node.matches('[data-turn="assistant"]') && node.querySelector('[data-message-author-role]')) continue;
      const role = node.getAttribute('data-message-author-role') || node.getAttribute('data-turn');
      if (role !== 'user' && role !== 'assistant') continue;
      const text = node.textContent?.trim() || '';
      if (!text) continue;
      const container = node.closest('[data-message-id]') || node;
      const messageId = container.getAttribute('data-message-id') || null;
      messages.push({ message_id: messageId, role, text });
    }
    return messages;
  });
}

async function observeSession(id) {
  const sessions = sessionState();
  const saved = sessions[id];
  if (!saved?.url) throw new Error("Ego Browser Chat session is unavailable");
  const task = await runtimeTaskForSpace(spaceIdForSession(saved, saved.project_id));
  const page = await pageForSession(task, id, sessions, saved?.web_project_url || null);
  const messages = await sessionMessages(page);
  return {
    session_id: id,
    messages,
    pending_body: saved.pending_body,
    pending_user_message_id: saved.pending_user_message_id,
    generating: await page.evaluate(() => Boolean(document.querySelector('button[aria-label="Stop answering"], button[data-testid="stop-button"]'))),
    cursor: messages.at(-1)?.message_id || null,
  };
}

function userText(payload) {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const last = [...input].reverse().find((item) => item?.role === "user");
  const content = Array.isArray(last?.content) ? last.content : [];
  const text = content.find((item) => item?.type === "input_text")?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("Responses input has no user text");
  return text;
}

function sessionId(payload) {
  const value = payload?.metadata?.webcodex_session_id;
  if (typeof value !== "string" || !/^wc_chat_[A-Za-z0-9]+$/.test(value)) {
    throw new Error("Responses metadata.webcodex_session_id is required");
  }
  return value;
}

function projectId(payload) {
  const value = payload?.metadata?.webcodex_project_id;
  if (typeof value !== "string" || !value.trim()) throw new Error("Responses metadata.webcodex_project_id is required");
  return value.trim();
}

function spaceIdForSession(saved, projectId) {
  const config = projectSpaceConfig();
  const configured = projectId ? config.projects[projectId] : undefined;
  if (saved?.space_id !== undefined && configured !== undefined && Number(saved.space_id) !== Number(configured)) {
    throw new Error("Ego Browser TaskSpace does not match the Project binding");
  }
  const hasExplicitProjectMap = Object.keys(config.projects).length > 0;
  const raw = saved?.space_id ?? configured ?? (
    projectId && hasExplicitProjectMap
      ? null
      : config.defaultSpaceId ?? spaceIdFromEnv ?? runtimeState()?.space_id
  );
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`No Ego Browser TaskSpace is configured for Project ${projectId || "unknown"}`);
  }
  return value;
}

async function pageForSession(task, id, sessions, webProjectUrl) {
  const saved = sessions[id];
  if (saved && (saved.web_project_url || null) !== webProjectUrl) {
    throw new Error("web_project_url does not match the existing Chat session binding");
  }
  if (saved?.page_label) {
    let page;
    try {
      page = task.page(saved.page_label);
    } catch (error) {
      if (!/page .* was closed|page .* not found/i.test(String(error))) throw error;
    }
    if (page) {
      try {
        if (saved.url && (await page.url()) !== saved.url) await page.goto(saved.url);
        await waitForComposer(page);
        return page;
      } catch (error) {
        if (!/page .* was closed/i.test(String(error))) throw error;
      }
    }
    delete saved.page_label;
    writeJson(sessionsPath, sessions);
  }
  let page;
  try {
    page = await task.newPage();
  } catch (error) {
    if (!/page budget reached/i.test(String(error))) throw error;
    const victim = Object.entries(sessions).find(([sessionId, value]) => sessionId !== id && value?.page_label
      && !value.pending_body
      && (task.spaceId === undefined || Number(value.space_id) === Number(task.spaceId)));
    if (!victim) throw error;
    const victimPage = task.page(victim[1].page_label);
    if (victimPage) {
      try { await victimPage.close(); } catch (closeError) {
        if (!/page .* was closed/i.test(String(closeError))) throw closeError;
      }
    }
    delete victim[1].page_label;
    writeJson(sessionsPath, sessions);
    page = await task.newPage();
  }
  await page.goto(saved?.url || webProjectUrl || "https://chatgpt.com/");
  await waitForComposer(page);
  if (!saved?.url && webProjectUrl) {
    const expected = new URL(webProjectUrl).pathname.match(/\/g\/(g-p-[a-f0-9]+)/i)?.[1];
    const actual = new URL(await page.url()).pathname;
    if (!expected || !actual.startsWith(`/g/${expected}`)) throw new Error("ChatGPT Project navigation did not preserve the configured Project; nothing was sent");
  }
  if (saved) {
    saved.page_label = page.label;
    writeJson(sessionsPath, sessions);
  }
  return page;
}

async function runResponse(payload) {
  const id = sessionId(payload);
  const project = projectId(payload);
  const text = userText(payload);
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model : "ego-chatgpt-web";
  const webProjectUrl = typeof payload.metadata?.web_project_url === "string" && payload.metadata.web_project_url.trim()
    ? payload.metadata.web_project_url.trim()
    : null;
  const sessions = sessionState();
  const saved = sessions[id];
  if (saved?.project_id && saved.project_id !== project) {
    throw new Error("webcodex_project_id does not match the existing Chat session binding");
  }
  const spaceId = spaceIdForSession(saved, project);
  if (payload.previous_response_id && payload.previous_response_id !== saved?.response_id) {
    throw new Error("previous_response_id does not match the Ego Browser session state");
  }
  const task = await runtimeTaskForSpace(spaceId);
  await waitForSendWindow();
  const page = await pageForSession(task, id, sessions, webProjectUrl);
  await dismissRateLimitDialog(page);
  // A visible rate-limit banner means no prompt has been submitted yet.
  // Keep the existing page bound and let the caller back off safely.
  if (await pageHasRateLimit(page)) throw markRateLimited(true);
  markSendStarted();
  sessions[id] = { ...(saved || {}), page_label: page.label, url: await page.url(), project_id: project, space_id: spaceId, web_project_url: webProjectUrl, pending_body: text, pending_user_message_id: null };
  writeJson(sessionsPath, sessions);
  const previousUserId = await page.evaluate(() => [...document.querySelectorAll('[data-message-author-role="user"]')].at(-1)?.getAttribute('data-message-id'));
  await page.fill("loc=css:#prompt-textarea", text);
  await page.click('loc=css:button[aria-label="Send prompt"]');
  await page.waitForURL(/\/c\//, { timeout: 30_000 });
  sessions[id].url = await page.url();
  writeJson(sessionsPath, sessions);
  const deadline = Date.now() + 3_600_000;
  let result;
  while (Date.now() < deadline) {
    if (!sessions[id].pending_user_message_id) {
      const userId = await page.evaluate(() => [...document.querySelectorAll('[data-message-author-role="user"]')].at(-1)?.getAttribute('data-message-id'));
      if (userId && userId !== previousUserId) {
        sessions[id].pending_user_message_id = userId;
        writeJson(sessionsPath, sessions);
      }
    }
    result = await page.evaluate(completedTurn, { body: text, userMessageId: sessions[id].pending_user_message_id });
    if (result) break;
    if (await pageHasRateLimit(page)) throw markRateLimited(false);
    await sleep(1000);
  }
  if (!result) throw new Error("Ego Browser assistant response did not complete within one hour");
  const responseId = `ego_${createHash("sha256").update(`${id}\0${result.messageId || result.text}`).digest("hex").slice(0, 32)}`;
  sessions[id] = {
    ...(saved || {}),
    page_label: page.label,
    url: await page.url(),
    response_id: responseId,
    project_id: project,
    space_id: spaceId,
    web_project_url: webProjectUrl,
  };
  delete sessions[id].pending_body;
  delete sessions[id].pending_user_message_id;
  writeJson(sessionsPath, sessions);
  markSendSucceeded();
  return {
    id: responseId,
    object: "response",
    model,
    output_text: result.text,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: result.text }] }],
  };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...extraHeaders });
  response.end(body);
}

function sessionIdFromPath(pathname) {
  const match = pathname.match(/^\/v1\/sessions\/(wc_chat_[A-Za-z0-9]+)\/messages$/);
  if (!match) throw new Error("invalid Chat session path");
  return match[1];
}

async function serve() {
  // Keep sends serialized, but observations must remain available while a long
  // browser turn is still generating. A rejected send must not poison the queue.
  const queue = { tail: Promise.resolve() };
  const enqueueSend = (operation) => {
    const result = queue.tail.then(operation);
    queue.tail = result.catch(() => {});
    return result;
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      const spaceIds = configuredSpaceIds();
      send(response, 200, { ok: true, provider: "ego-browser", space_ids: spaceIds, space_id: spaceIds.length === 1 ? spaceIds[0] : null });
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      send(response, 200, { ok: true });
      setTimeout(() => server.close(), 0);
      return;
    }
    if (request.method === "GET") {
      try {
        const url = new URL(request.url, "http://127.0.0.1");
        const id = sessionIdFromPath(url.pathname);
        const result = await observeSession(id);
        send(response, 200, result);
      } catch (error) {
        send(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      send(response, 404, { error: "not_found" });
      return;
    }
    try {
      const payload = await readBody(request);
      const result = await enqueueSend(() => runResponse(payload));
      send(response, 200, result);
    } catch (error) {
      if (error instanceof RateLimitError) {
        const code = error.safeToRetry ? "preflight_rate_limited" : "turn_rate_limited";
        send(response, 429, {
          error: { code, message: error.message, retry_after_ms: error.retryAfterMs },
        }, { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) });
      } else {
        send(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }
  });
  await new Promise((resolveServer) => server.listen(port, "127.0.0.1", resolveServer));
  process.stdout.write(`ego-browser provider listening on http://127.0.0.1:${port}\n`);
}

async function setup() {
  const task = await setupTask();
  const page = await task.newPage();
  try {
    await page.goto("https://chatgpt.com/");
    await waitForComposer(page);
    writeJson(statePath, { provider: "ego-browser", space_id: task.spaceId, configured_at: new Date().toISOString() });
    process.stdout.write(JSON.stringify({ configured: true, provider: "ego-browser", space_id: task.spaceId }) + "\n");
  } finally {
    await page.close();
  }
}

async function status() {
  const state = runtimeState();
  if (!state) {
    process.stdout.write(JSON.stringify({ configured: false, provider: "ego-browser" }) + "\n");
    return;
  }
  const spaces = [];
  for (const spaceId of configuredSpaceIds()) {
    const task = await runtimeTaskForSpace(spaceId);
    spaces.push({ space_id: spaceId, pages: (await task.pages()).map((page) => page.label) });
  }
  process.stdout.write(JSON.stringify({ configured: true, provider: "ego-browser", spaces }) + "\n");
}

const mode = injected.mode || process.env.WEBCODEX_EGO_PROVIDER_MODE || process.argv[2] || "serve";
if (mode === "test") { /* Import-only mode for page lifecycle checks. */ }
else if (mode === "setup") await setup();
else if (mode === "status") await status();
else await serve();

export { pageForSession, spaceIdForSession, completedTurn };
