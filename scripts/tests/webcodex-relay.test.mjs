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
  assert.equal(directive("说明需要使用 [to:QC02] 标记，但本条没有实际路由。", { QC02: "wc_chat_target" }), null);
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
    assert.equal(config.poll_ms, 5000);
    assert.equal(config.min_send_interval_ms, 15000);
    assert.equal(config.rate_limit_backoff_ms, 30000);
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

test("processMessage forwards the prompt from a valid structured route", async () => {
  const root = await mkdtemp(join(tmpdir(), "webcodex-relay-structured-"));
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
    return Response.json({ state: "completed", assistant_body: "结构化结果" });
  };
  try {
    await processMessage(config, state, {
      message_id: "structured-1",
      role: "user",
      text: JSON.stringify({
        version: 1,
        destination: { kind: "web_chat", alias: "QC02" },
        prompt: "请检查数据质量",
        mode: "serial",
        acceptance: ["返回证据"],
      }),
    }, statePath);
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(calls[0].body.body, "请检查数据质量");
  assert.equal(state.events["structured-1"].state, "replied");
});

test("processMessage dispatches a local_runner route through Runner and Codex CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "webcodex-relay-local-runner-"));
  const statePath = join(root, "state.json");
  const state = { version: 1, profile: "quantcompany", ignored_message_ids: [], events: {} };
  const config = {
    api_url: "http://webcodex.test",
    provider_url: "http://provider.test",
    profile: "quantcompany",
    project: "agent:test:quantcompany",
    controller_session: "wc_chat_controller",
    targets: {},
    min_send_interval_ms: 0,
    poll_ms: 1_000,
    local_runner_max_wait_ms: 10_000,
  };
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith("/api/connector/task/start")) {
      assert.match(body.goal, /读取仓库并只返回名称/);
      assert.match(body.goal, /返回结果/);
      return Response.json({ ok: true, task_id: "wc_task_local123", run_id: "wc_run_local123", data: {} });
    }
    if (url.endsWith("/api/connector/commands/run")) {
      assert.match(body.command, /codex exec .*--model gpt-6-astra .*medium/);
      assert.match(body.command, /读取仓库并只返回名称/);
      return Response.json({
        ok: true,
        task_id: body.task_id,
        data: { execution: { execution_status: "running", capability_outcome: "in_progress" } },
      });
    }
    if (url.endsWith("/api/connector/task/review")) {
      assert.equal(body.task_id, "wc_task_local123");
      return Response.json({
        ok: true,
        task_id: body.task_id,
        data: {
          execution: {
            execution_status: "succeeded",
            capability_outcome: "completed",
            exit_code: 0,
            output_tail: { stdout: "本地 Codex 已完成\n", stderr: "", bounded: true },
          },
        },
      });
    }
    if (url.endsWith("/api/chat/session")) {
      assert.equal(body.action, "send");
      assert.equal(body.session_id, "wc_chat_controller");
      assert.equal(body.body, "[from:LOCAL_RUNNER]\n本地 Codex 已完成");
      return Response.json({ state: "completed", assistant_body: "已回传" });
    }
    throw new Error(`unexpected call: ${url}`);
  };
  try {
    await processMessage(config, state, {
      message_id: "local-1",
      role: "user",
      text: JSON.stringify({
        version: 1,
        destination: { kind: "local_runner", project: "agent:test:quantcompany" },
        prompt: "读取仓库并只返回名称",
        mode: "serial",
        acceptance: ["返回结果"],
      }),
    }, statePath);
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(calls.filter(({ url }) => url.endsWith("/api/connector/task/start")).length, 1);
  assert.equal(calls.filter(({ url }) => url.endsWith("/api/connector/commands/run")).length, 1);
  assert.equal(state.events["local-1"].target_kind, "local_runner");
  assert.equal(state.events["local-1"].local_task_id, "wc_task_local123");
  assert.equal(state.events["local-1"].state, "replied");
  assert.equal(state.events["local-1"].result_body, "本地 Codex 已完成");
});

test("processMessage repairs malformed structured content once before forwarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "webcodex-relay-repair-"));
  const statePath = join(root, "state.json");
  const state = { version: 1, profile: "quantcompany", ignored_message_ids: [], events: {} };
  const config = {
    api_url: "http://webcodex.test",
    provider_url: "http://provider.test",
    profile: "quantcompany",
    controller_session: "wc_chat_controller",
    targets: { QC02: "wc_chat_qc02" },
    route_repair_runner: async () => JSON.stringify({
      version: 1,
      destination: { kind: "web_chat", alias: "QC02" },
      prompt: "修复后转发",
      mode: "serial",
      acceptance: ["返回回执"],
    }),
  };
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (calls.length % 2 === 1) return Response.json({ operation_id: `wc_chat_op_${calls.length}` }, { status: 202 });
    return Response.json({ state: "completed", assistant_body: "修复结果" });
  };
  try {
    await processMessage(config, state, { message_id: "repair-1", role: "user", text: "{ malformed route" }, statePath);
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(calls[0].body.body, "修复后转发");
  assert.equal(state.events["repair-1"].route_source, "codex_cli_fallback");
  assert.equal(state.events["repair-1"].state, "replied");
});

test("thinking failures continue on the routed target before replying", async () => {
  const root = await mkdtemp(join(tmpdir(), "webcodex-relay-thinking-failed-"));
  const statePath = join(root, "state.json");
  const state = { version: 1, profile: "quantcompany", ignored_message_ids: [], events: {} };
  const config = {
    api_url: "http://webcodex.test",
    provider_url: "http://provider.test",
    profile: "quantcompany",
    controller_session: "wc_chat_controller",
    targets: { QC02: "wc_chat_qc02" },
    min_send_interval_ms: 0,
  };
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (body.action === "send" && body.session_id === "wc_chat_qc02" && body.body !== "continue") {
      return Response.json({ operation_id: "wc_chat_op_forward" }, { status: 202 });
    }
    if (body.action === "operation" && body.operation_id === "wc_chat_op_forward") {
      return Response.json({ state: "completed", assistant_body: "Thinking failed" });
    }
    if (body.action === "send" && body.session_id === "wc_chat_qc02" && body.body === "continue") {
      return Response.json({ operation_id: "wc_chat_op_continue" }, { status: 202 });
    }
    if (body.action === "operation" && body.operation_id === "wc_chat_op_continue") {
      return Response.json({ state: "completed", assistant_body: "继续结果" });
    }
    if (body.action === "send" && body.session_id === "wc_chat_controller") {
      return Response.json({ operation_id: "wc_chat_op_reply" }, { status: 202 });
    }
    if (body.action === "operation" && body.operation_id === "wc_chat_op_reply") {
      return Response.json({ state: "completed", assistant_body: "已回传" });
    }
    throw new Error(`unexpected call: ${JSON.stringify(body)}`);
  };
  try {
    await processMessage(config, state, { message_id: "thinking-1", role: "user", text: "[to:QC02]\n继续处理" }, statePath);
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(calls[2].body.body, "continue");
  assert.equal(calls[2].body.session_id, "wc_chat_qc02");
  assert.equal(state.events["thinking-1"].retried, true);
  assert.equal(state.events["thinking-1"].state, "replied");
  assert.equal(state.events["thinking-1"].result_body, "继续结果");
});

test("preflight rate limits are checkpointed and safely retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "webcodex-relay-rate-limit-"));
  const statePath = join(root, "state.json");
  const state = { version: 1, profile: "quantcompany", ignored_message_ids: [], events: {} };
  const config = {
    api_url: "http://webcodex.test",
    provider_url: "http://provider.test",
    profile: "quantcompany",
    controller_session: "wc_chat_controller",
    targets: { QC02: "wc_chat_qc02" },
    min_send_interval_ms: 0,
    rate_limit_backoff_ms: 1_000,
  };
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return Response.json({ error: { code: "preflight_rate_limited", retry_after_ms: 1 } }, { status: 429 });
    if (calls % 2 === 0) return Response.json({ operation_id: `op-${calls}` }, { status: 202 });
    return Response.json({ state: "completed", assistant_body: "本地结果" });
  };
  try {
    const message = { message_id: "u-rate", role: "user", text: "[to:QC02]\n读取状态" };
    await processMessage(config, state, message, statePath);
    assert.equal(state.events["u-rate"].state, "rate_limited");
    state.events["u-rate"].retry_at = 0;
    await processMessage(config, state, message, statePath);
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal(state.events["u-rate"].state, "replied");
  assert.equal(state.events["u-rate"].result_body, "本地结果");
});
