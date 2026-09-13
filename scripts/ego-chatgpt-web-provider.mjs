import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";

const injected = globalThis.__WEBCODEX_PROVIDER_CONFIG || {};
const root = resolve(injected.root || process.env.WEBCODEX_RUNTIME_HOME || `${process.env.HOME}/.config/webcodex`);
const port = Number(injected.port || process.env.WEBCODEX_CHATGPT_WEB_PORT || 17841);
const statePath = `${root}/ego/runtime.json`;
const sessionsPath = `${root}/ego/sessions.json`;
const spaceIdFromEnv = String(injected.spaceId || process.env.WEBCODEX_EGO_SPACE_ID || "").trim();
const maxBodyBytes = 1_000_000;

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
  return openTaskSpace(requireSpaceId());
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

async function currentTurnCount(page) {
  return page.evaluate(() => document.querySelectorAll('[data-turn="assistant"]').length);
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

async function pageForSession(task, id, sessions) {
  const saved = sessions[id];
  if (saved?.page_label) {
    const page = task.page(saved.page_label);
    if (!page) throw new Error("Ego Browser page for this Chat session is unavailable");
    if (saved.url && (await page.url()) !== saved.url) await page.goto(saved.url);
    await waitForComposer(page);
    return page;
  }
  const page = await task.newPage();
  await page.goto("https://chatgpt.com/");
  await waitForComposer(page);
  return page;
}

async function runResponse(payload) {
  const id = sessionId(payload);
  const text = userText(payload);
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model : "ego-chatgpt-web";
  const sessions = sessionState();
  const saved = sessions[id];
  if (payload.previous_response_id && payload.previous_response_id !== saved?.response_id) {
    throw new Error("previous_response_id does not match the Ego Browser session state");
  }
  const task = await runtimeTask();
  const page = await pageForSession(task, id, sessions);
  const before = await currentTurnCount(page);
  await page.fill("loc=css:#prompt-textarea", text);
  await page.press("loc=css:#prompt-textarea", "Enter");
  await page.waitForFunction((turnCount) => {
    const turns = document.querySelectorAll('[data-turn="assistant"]');
    const latest = turns[turns.length - 1];
    const stop = document.querySelector('button[aria-label="Stop answering"]');
    return turns.length > turnCount && !stop && Boolean(latest?.textContent?.trim());
  }, before, { timeout: 180_000 });
  const result = await page.evaluate(() => {
    const turns = [...document.querySelectorAll('[data-turn="assistant"]')];
    const turn = turns.at(-1);
    const message = turn?.querySelector('[data-message-author-role="assistant"]');
    return {
      text: message?.textContent?.trim() || turn?.textContent?.trim() || "",
      messageId: message?.getAttribute("data-message-id") || null,
    };
  });
  if (!result.text) throw new Error("Ego Browser returned an empty assistant turn");
  const responseId = `ego_${createHash("sha256").update(`${id}\0${result.messageId || result.text}`).digest("hex").slice(0, 32)}`;
  sessions[id] = { page_label: page.label, url: await page.url(), response_id: responseId };
  writeJson(sessionsPath, sessions);
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

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function serve() {
  // ponytail: serialize all browser turns; add per-session locks only if throughput requires it.
  const queue = { tail: Promise.resolve() };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      send(response, 200, { ok: true, provider: "ego-browser", space_id: requireSpaceId() });
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      send(response, 200, { ok: true });
      setTimeout(() => server.close(), 0);
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      send(response, 404, { error: "not_found" });
      return;
    }
    try {
      const payload = await readBody(request);
      const result = await new Promise((resolveResult, rejectResult) => {
        queue.tail = queue.tail.then(() => runResponse(payload).then(resolveResult, rejectResult));
      });
      send(response, 200, result);
    } catch (error) {
      send(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
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
  const task = await runtimeTask();
  process.stdout.write(JSON.stringify({ configured: true, provider: "ego-browser", space_id: requireSpaceId(), pages: (await task.pages()).map((page) => page.label) }) + "\n");
}

const mode = injected.mode || process.env.WEBCODEX_EGO_PROVIDER_MODE || process.argv[2] || "serve";
if (mode === "setup") await setup();
else if (mode === "status") await status();
else await serve();
