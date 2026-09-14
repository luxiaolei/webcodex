import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "webcodex-page-pool-"));
mkdirSync(join(root, "ego"));
writeFileSync(join(root, "ego", "project-spaces.json"), JSON.stringify({ projects: { qc: 2, hz: 1 } }));
globalThis.__WEBCODEX_PROVIDER_CONFIG = { mode: "test", root };
const { pageForSession, spaceIdForSession, completedTurn } = await import("../ego-chatgpt-web-provider.mjs");
delete globalThis.__WEBCODEX_PROVIDER_CONFIG;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("closed pages rebind the exact Chat and reclaim an idle page at the budget", async () => {
  const project = "https://chatgpt.com/g/g-p-example/project";
  const chat = "https://chatgpt.com/g/g-p-example/c/existing";
  const sessions = {
    target: { page_label: "p1", url: chat, response_id: "response-1", web_project_url: project },
    idle: { page_label: "p2", url: "https://chatgpt.com/c/idle", web_project_url: null },
  };
  let closed = false;
  let calls = 0;
  let navigated;
  const page = { label: "p3", async goto(url) { navigated = url; }, async waitForSelector() {} };
  const task = {
    page(label) {
      return label === "p1" ? { async url() { throw new Error("page p1 was closed"); } }
        : { async close() { closed = true; } };
    },
    async newPage() {
      if (++calls === 1) throw new Error("Page budget reached (8/8)");
      return page;
    },
  };
  assert.equal(await pageForSession(task, "target", sessions, project), page);
  assert.equal(navigated, chat);
  assert.equal(closed, true);
  assert.equal(sessions.target.page_label, "p3");
  assert.equal(sessions.target.response_id, "response-1");
  assert.equal(sessions.idle.page_label, undefined);
  await assert.rejects(pageForSession(task, "target", sessions, "https://chatgpt.com/g/other/project"), /does not match/);
});

test("Project bindings select their configured Ego TaskSpace", () => {
  assert.equal(spaceIdForSession({}, "qc"), 2);
  assert.equal(spaceIdForSession({}, "hz"), 1);
  assert.throws(() => spaceIdForSession({ space_id: 1 }, "qc"), /does not match/);
});

test("completion matches the request and final actions without relying on visible turn counts", () => {
  let stopping = false;
  let finalActions = false;
  const node = (role, text) => ({
    textContent: text,
    matches: () => false,
    getAttribute: (name) => name === 'data-message-author-role' ? role : name === 'data-message-id' ? `${role}-id` : null,
    closest: () => ({ querySelector: () => finalActions, getAttribute: () => 'turn-new' }),
  });
  const request = node('user', 'send this');
  const reply = node('assistant', '{"version":');
  let nodes = [request, reply];
  const previous = globalThis.document;
  globalThis.document = { querySelector: () => stopping, querySelectorAll: () => nodes };
  try {
    assert.equal(completedTurn('send this'), null, 'a streaming preview is not complete');
    finalActions = true;
    reply.textContent = 'full answer';
    assert.equal(completedTurn(' send   this ').text, 'full answer');
    assert.equal(completedTurn('different request'), null);
    request.textContent = 'json {"task":"done"}';
    assert.equal(completedTurn({ body: '```json\n{"task":"done"}\n```', userMessageId: 'user-id' }).text, 'full answer');
    request.textContent = 'send this';
    stopping = true;
    assert.equal(completedTurn('send this'), null);
    stopping = false;
    nodes = [request, reply, request, reply];
    assert.equal(completedTurn('send this'), null, 'duplicate bodies are ambiguous');
  } finally { globalThis.document = previous; }
});
