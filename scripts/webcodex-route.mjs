#!/usr/bin/env node

import { spawn } from "node:child_process";

const MAX_PROMPT_CHARS = 32_768;
const MAX_ACCEPTANCE_ITEMS = 32;
const MAX_REPAIR_OUTPUT_CHARS = 1_000_000;
const DEFAULT_REPAIR_TIMEOUT_MS = 30_000;
const MODEL_REASONING_EFFORTS = Object.freeze({
  "gpt-6-astra": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-sol": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-terra": new Set(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-luna": new Set(["low", "medium", "high", "xhigh", "max"]),
  "gpt-5.5": new Set(["low", "medium", "high", "xhigh"]),
  "gpt-5.3-codex-spark": new Set(["low", "medium", "high", "xhigh"]),
});

export function validateModelSettings(model, reasoningEffort) {
  if (model !== undefined) {
    if (typeof model !== "string" || !Object.hasOwn(MODEL_REASONING_EFFORTS, model)) {
      throw new Error(`model is not supported: ${model}`);
    }
  }
  if (reasoningEffort !== undefined) {
    if (typeof reasoningEffort !== "string") throw new Error("reasoning_effort must be a string");
    const allowed = model ? MODEL_REASONING_EFFORTS[model] : new Set(Object.values(MODEL_REASONING_EFFORTS).flatMap((values) => [...values]));
    if (!allowed.has(reasoningEffort)) {
      throw new Error(`reasoning_effort '${reasoningEffort}' is not supported${model ? ` for model '${model}'` : ""}`);
    }
  }
  return { model, reasoning_effort: reasoningEffort };
}

function unknownFields(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown field '${path}${key}'`);
  }
}

function nonEmptyString(value, field, max = 4_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return value.trim();
}

function parseJsonCandidate(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("route response is empty");
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  let value;
  try {
    value = JSON.parse(candidate);
  } catch (error) {
    throw new Error(`route response is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("route response must be a JSON object");
  }
  return value;
}

function validateSource(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("source must be an object");
  unknownFields(value, new Set(["issue", "sha"]), "source.");
  const source = {};
  if (value.issue !== undefined) source.issue = nonEmptyString(value.issue, "source.issue", 256);
  if (value.sha !== undefined) source.sha = nonEmptyString(value.sha, "source.sha", 128);
  if (!Object.keys(source).length) throw new Error("source must contain issue or sha");
  return source;
}

export function parseRouteDecision(text) {
  const value = parseJsonCandidate(text);
  unknownFields(value, new Set(["version", "destination", "prompt", "mode", "acceptance", "source", "reason", "model", "reasoning_effort"]), "");
  if (value.version !== 1) throw new Error("version must be 1");
  if (!value.destination || typeof value.destination !== "object" || Array.isArray(value.destination)) {
    throw new Error("destination must be an object");
  }
  unknownFields(value.destination, new Set(["kind", "alias", "project"]), "destination.");
  const kind = value.destination.kind;
  if (kind !== "web_chat" && kind !== "local_runner") {
    throw new Error("destination.kind must be web_chat or local_runner");
  }
  const destination = { kind };
  if (kind === "web_chat") {
    if (value.destination.project !== undefined) throw new Error("destination.project is only valid for local_runner");
    const alias = nonEmptyString(value.destination.alias, "destination.alias", 128);
    if (!/^[A-Za-z0-9_.-]+$/.test(alias)) throw new Error("destination.alias contains invalid characters");
    destination.alias = alias;
  } else {
    if (value.destination.alias !== undefined) throw new Error("destination.alias is only valid for web_chat");
    destination.project = nonEmptyString(value.destination.project, "destination.project", 512);
  }
  const prompt = nonEmptyString(value.prompt, "prompt", MAX_PROMPT_CHARS);
  if (value.mode !== "serial" && value.mode !== "parallel") throw new Error("mode must be serial or parallel");
  if (!Array.isArray(value.acceptance) || value.acceptance.length < 1) {
    throw new Error("acceptance must contain at least one item");
  }
  if (value.acceptance.length > MAX_ACCEPTANCE_ITEMS) throw new Error("acceptance has too many items");
  const acceptance = value.acceptance.map((item, index) => nonEmptyString(item, `acceptance[${index}]`, 1_000));
  validateModelSettings(value.model, value.reasoning_effort);
  if (kind === "web_chat" && (value.model !== undefined || value.reasoning_effort !== undefined)) {
    throw new Error("model and reasoning_effort are only valid for local_runner");
  }
  const route = { version: 1, destination, prompt, mode: value.mode, acceptance };
  if (value.model !== undefined) route.model = value.model;
  if (value.reasoning_effort !== undefined) route.reasoning_effort = value.reasoning_effort;
  const source = validateSource(value.source);
  if (source) route.source = source;
  if (value.reason !== undefined) route.reason = nonEmptyString(value.reason, "reason", 2_000);
  return route;
}

function repairPrompt(original) {
  return [
    "You are a route-format repairer, not a planner.",
    "Convert the controller output below into exactly one valid JSON route decision.",
    "Do not change the intended destination or prompt. Do not execute tools.",
    "The JSON schema is: version=1; destination.kind is web_chat with alias OR local_runner with project;",
    "prompt is non-empty; mode is serial or parallel; acceptance is a non-empty string array.",
    "For local_runner only, optional model is one of gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.3-codex-spark; optional reasoning_effort is low, medium, high, xhigh, max, or ultra, subject to the selected model.",
    "Return JSON only, with no markdown and no explanation.",
    "<controller_output>",
    String(original).slice(0, MAX_PROMPT_CHARS),
    "</controller_output>",
  ].join("\n");
}

function extractCodexText(stdout) {
  const candidates = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (typeof value.output_text === "string") candidates.push(value.output_text);
    if (typeof value.text === "string" && (value.type === "message" || value.type === "agent_message")) candidates.push(value.text);
    if (typeof value.item?.text === "string" && /message/i.test(String(value.item?.type || ""))) candidates.push(value.item.text);
  }
  return candidates.at(-1) || String(stdout).trim();
}

export function runCodexRouteRepair(prompt, options = {}) {
  const command = options.command || process.env.WEBCODEX_ROUTE_REPAIR_CODEX || "codex";
  const cwd = options.cwd || process.cwd();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_REPAIR_TIMEOUT_MS;
  const args = [
    "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
    "--model", "gpt-5.6-luna", "-c", 'model_reasoning_effort="xhigh"', "--json", "--cd", cwd, "-",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, WEBCODEX_ROUTE_REPAIR: "1" } });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error(`Codex route repair timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_REPAIR_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(reject, new Error(`Codex route repair exited ${code}: ${stderr.trim() || "no detail"}`));
        return;
      }
      finish(resolve, extractCodexText(stdout));
    });
    child.stdin.end(prompt);
  });
}

export async function parseRouteWithFallback(text, options = {}) {
  try {
    return { source: "programmatic", route: parseRouteDecision(text) };
  } catch (programmaticError) {
    const runFallback = options.runFallback || ((prompt) => runCodexRouteRepair(prompt, options));
    try {
      const repaired = await runFallback(repairPrompt(text));
      return { source: "codex_cli_fallback", route: parseRouteDecision(repaired) };
    } catch (fallbackError) {
      throw new Error(`route parsing failed; programmatic=${programmaticError.message}; fallback=${fallbackError.message}`);
    }
  }
}
