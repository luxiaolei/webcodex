import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { directive, loadConfig, processMessage } from "../webcodex-relay.mjs";

test("directive requires an explicit configured target", () => {
  assert.deepEqual(directive("[to:QC02]\n保留原文", { QC02: "wc_chat_target" }), {
    alias: "QC02",
    sessionId: "wc_chat_target",
  });
  assert.deepEqual(directive("请转发给“收敛技术 PR15”", { PR15: "wc_chat_target" }, { PR15: ["收敛技术 PR15"] }), {
    alias: "PR15",
    sessionId: "wc_chat_target",
  });
  assert.equal(directive("没有路由标记", { QC02: "wc_chat_target" }), null);
  assert.throws(() => directive("[to:missing]", { QC02: "wc_chat_target" }), /unknown relay target/);
});

test("profile validation keeps project routing explicit", () => {
  const path = join(tmpdir(), `webcodex-relay-${process.pid}.json`);
  return import("node:fs/promises").then(async ({ writeFile, rm }) => {
    await writeFile(path, JSON.stringify({
      profile: "hz-os",
      controller_session: "wc_chat_controller",
      targets: { PR15: "wc_chat_pr15" },
    }));
    const config = loadConfig(path);
    assert.equal(config.profile, "hz-os");
    assert.equal(config.targets.PR15, "wc_chat_pr15");
    await rm(path);
  });
});

test("processMessage sends the exact source body and replies to the controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "webcodex-relay-test-"));
  const statePath = join(root, "state.json");
  const state = { version: 1, profile: "quantcompany", ignored_message_ids: [], events: {} };
  const config = {
    api_url: "http://webcodex.test",
    provider_url: "http://provider.test",
    token: "test-token",
    profile: "quantcompany",
    controller_session: "wc_chat_controller",
    targets: { QC02: "wc_chat_qc02" },
  };
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (calls.length % 2 === 1) return Response.json({ operation_id: `wc_chat_op_${calls.length}` }, { status: 202 });
    return Response.json({ state: "completed", assistant_body: "已完成" });
  };
  try {
    await processMessage(config, state, { message_id: "u1", role: "user", text: "[to:QC02]\n请原样处理" }, statePath);
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(calls[0].body.body, "[to:QC02]\n请原样处理");
  assert.equal(calls[2].body.session_id, "wc_chat_controller");
  assert.equal(state.events.u1.state, "replied");
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.events.u1.result_body, "已完成");
});
