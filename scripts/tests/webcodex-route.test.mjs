import assert from "node:assert/strict";
import test from "node:test";

import { parseRouteDecision, parseRouteWithFallback } from "../webcodex-route.mjs";

test("parses a strict structured route decision", () => {
  const decision = parseRouteDecision(JSON.stringify({
    version: 1,
    destination: { kind: "local_runner", project: "quantcompany" },
    prompt: "Run the focused checks",
    mode: "serial",
    acceptance: ["return the test receipt"],
  }));

  assert.deepEqual(decision, {
    version: 1,
    destination: { kind: "local_runner", project: "quantcompany" },
    prompt: "Run the focused checks",
    mode: "serial",
    acceptance: ["return the test receipt"],
  });
});

test("uses one fallback parser when structured content is invalid", async () => {
  const decision = await parseRouteWithFallback(
    "The controller response was not JSON.",
    {
      runFallback: async () => JSON.stringify({
        version: 1,
        destination: { kind: "web_chat", alias: "QC02" },
        prompt: "Check the data quality",
        mode: "serial",
        acceptance: ["include evidence"],
      }),
    },
  );

  assert.equal(decision.source, "codex_cli_fallback");
  assert.equal(decision.route.destination.alias, "QC02");
});

test("rejects an invalid fallback instead of returning an unsafe route", async () => {
  await assert.rejects(
    parseRouteWithFallback("not structured", {
      runFallback: async () => JSON.stringify({
        version: 1,
        destination: { kind: "web_chat", alias: "QC02" },
        prompt: "",
        mode: "serial",
        acceptance: [],
      }),
    }),
    /prompt must be a non-empty string|acceptance must contain at least one item/,
  );
});

test("rejects unknown route kinds and extra fields", () => {
  assert.throws(
    () => parseRouteDecision(JSON.stringify({
      version: 1,
      destination: { kind: "unknown", alias: "QC02" },
      prompt: "Do work",
      mode: "serial",
      acceptance: ["receipt"],
    })),
    /destination.kind must be web_chat or local_runner/,
  );

  assert.throws(
    () => parseRouteDecision(JSON.stringify({
      version: 1,
      destination: { kind: "web_chat", alias: "QC02" },
      prompt: "Do work",
      mode: "serial",
      acceptance: ["receipt"],
      unexpected: true,
    })),
    /unknown field 'unexpected'/,
  );
});
