import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_GLOBAL_CONFIG,
  armRouteTicket,
  appendObservation,
  createRouteTicket,
  getEffectiveConfig,
  loadGlobalConfig,
  loadTaskState,
  mutateTaskState,
  resolveDataDir,
  saveTaskState,
  updateGlobalConfig
} from "../plugins/model-watch/src/state.mjs";
import { hashPrompt } from "../plugins/model-watch/src/engine.mjs";

function withDataDir(run) {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-state-"));
  try { run(dataDir); } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

test("uses model-only safe defaults", () => withDataDir((dataDir) => {
  assert.deepEqual(loadGlobalConfig(dataDir), DEFAULT_GLOBAL_CONFIG);
  assert.equal(loadTaskState("old-task", dataDir).enabled, false);
  assert.equal(loadGlobalConfig(dataDir).evaluatorMode, "same-session");
  assert.equal(loadGlobalConfig(dataDir).evaluatorModel, "gpt-5.6-terra");
  assert.equal(loadGlobalConfig(dataDir).preferGpt, true);
  assert.equal(loadGlobalConfig(dataDir).externalModelThreshold, 30);
}));

test("task status-indicator override wins over the global setting", () => withDataDir((dataDir) => {
  updateGlobalConfig({ showStatusIndicator: true }, dataDir);
  const task = loadTaskState("task-1", dataDir);
  task.override = { showStatusIndicator: false };
  saveTaskState("task-1", task, dataDir);
  const effective = getEffectiveConfig("task-1", dataDir);
  assert.equal(effective.showStatusIndicator, false);
  assert.equal("reminderTiming" in effective, false);
  assert.equal(effective.evaluatorMode, "same-session");
}));

test("legacy routing settings are ignored and fixed evaluator settings are normalized", () => withDataDir((dataDir) => {
  const migrated = updateGlobalConfig({
    reminderTiming: "manual",
    evaluatorMode: "external-api",
    externalBaseUrl: "https://example.com/v1"
  }, dataDir);
  assert.deepEqual(migrated, DEFAULT_GLOBAL_CONFIG);
  const fixed = updateGlobalConfig({ evaluatorMode: "fixed-codex", evaluatorModel: "gpt-5.6-sol" }, dataDir);
  assert.equal(fixed.evaluatorMode, "fixed-codex");
  assert.equal(fixed.evaluatorModel, "gpt-5.6-sol");
  assert.equal(updateGlobalConfig({ evaluatorModel: "not-a-model" }, dataDir).evaluatorModel, "gpt-5.6-terra");
  assert.equal(updateGlobalConfig({ externalModelThreshold: 47, preferGpt: false }, dataDir).externalModelThreshold, 47);
  assert.equal(loadGlobalConfig(dataDir).preferGpt, false);
  assert.equal(updateGlobalConfig({ externalModelThreshold: 101 }, dataDir).externalModelThreshold, 30);
}));

test("assessment telemetry keeps fallback and cost metadata without task text", () => withDataDir((dataDir) => {
  const task = loadTaskState("telemetry-task", dataDir);
  task.assessmentHistory = [{
    assessmentId: "assessment-1",
    turnId: "turn-1",
    promptHash: hashPrompt("不应写入记录的任务正文"),
    originalModel: "gpt-5.6-luna",
    availableModels: ["gpt-5.6-luna", "gpt-5.6-terra"],
    status: "stay",
    rationale: "同会话回退完成",
    evaluator: "same-session",
    evaluatorModel: "gpt-5.6-luna",
    requestedEvaluatorModel: "gpt-5.6-terra",
    evaluatorMode: "same-session",
    contextCoverage: "same-session",
    fallback: { from: "fixed-codex", to: "same-session", reason: "固定评估器超时", at: new Date().toISOString() },
    durationMs: 20_000,
    cost: { kind: "unavailable", currency: "USD", estimatedUsd: null, note: "不能归因" }
  }];
  const saved = saveTaskState("telemetry-task", task, dataDir);
  const record = saved.assessmentHistory[0];
  assert.equal(record.requestedEvaluatorModel, "gpt-5.6-terra");
  assert.equal(record.fallback.to, "same-session");
  assert.equal(record.durationMs, 20_000);
  assert.equal(record.cost.estimatedUsd, null);
  assert.equal(JSON.stringify(record).includes("不应写入记录的任务正文"), false);
}));

test("route ticket stores only a request hash and model metadata", () => {
  const ticket = createRouteTicket({
    turnId: "turn-1",
    promptHash: hashPrompt("敏感任务正文"),
    originalModel: "gpt-5.6-terra"
  }, "gpt-5.6-sol", 1_800_000_000_000);
  assert.equal(ticket.promptHash.length, 64);
  assert.equal(JSON.stringify(ticket).includes("敏感任务正文"), false);
  assert.equal(ticket.recommendedModel, "gpt-5.6-sol");
});

test("route ticket arms idempotently without storing the task text", () => {
  const ticket = createRouteTicket({
    turnId: "turn-arm",
    promptHash: hashPrompt("不可保存的原始任务"),
    originalModel: "gpt-5.6-luna"
  }, "gpt-5.6-sol", 1_800_000_000_000, "assessment-arm");
  const armed = armRouteTicket(ticket, {
    gateId: ticket.gateId,
    decision: "acknowledged",
    idempotencyKey: "click-1"
  }, 1_800_000_000_100);
  const repeated = armRouteTicket(armed, {
    gateId: ticket.gateId,
    decision: "acknowledged",
    idempotencyKey: "click-1"
  }, 1_800_000_000_200);
  assert.equal(armed.status, "armed");
  assert.equal(armed.explicitDecision, "acknowledged");
  assert.equal(repeated.resumeNonce, armed.resumeNonce);
  assert.equal(JSON.stringify(armed).includes("不可保存的原始任务"), false);
  assert.equal(armRouteTicket(armed, {
    gateId: ticket.gateId,
    decision: "ignored",
    idempotencyKey: "click-2"
  }, 1_800_000_000_200), null);
});

test("observation history records actual model without explicit feedback", () => {
  const task = loadTaskState("memory-only", join(tmpdir(), `missing-${Date.now()}`));
  appendObservation(task, {
    result: "adopted",
    originalModel: "gpt-5.6-terra",
    recommendedModel: "gpt-5.6-sol",
    actualModel: "gpt-5.6-sol"
  });
  assert.equal(task.observationHistory.at(-1).result, "adopted");
});

test("state paths and plugin data directory stay scoped", () => withDataDir((dataDir) => {
  const task = loadTaskState("../../unsafe/session", dataDir);
  const saved = saveTaskState("../../unsafe/session", { ...task, enabled: true }, dataDir);
  assert.equal(saved.sessionId.includes("/"), false);
  const pluginData = join(tmpdir(), "codex-home", "plugins", "data", "model-watch-model-watch");
  const cacheRoot = join(tmpdir(), "codex-home", "plugins", "cache", "model-watch", "model-watch", "1.1.0");
  assert.equal(resolveDataDir({}, cacheRoot), pluginData);
  assert.equal(
    resolveDataDir({ CODEX_HOME: join(tmpdir(), "explicit-codex-home") }, join(tmpdir(), "unrelated-workspace")),
    join(tmpdir(), "explicit-codex-home", "model-watch")
  );
}));

test("dead owners do not leave task locks behind", () => withDataDir((dataDir) => {
  const taskDir = join(dataDir, "tasks");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "lock-test.json.lock"), JSON.stringify({ token: "dead", pid: 99999999, createdAt: 0 }));
  const task = mutateTaskState("lock-test", (draft) => ({ ...draft, enabled: true }), dataDir);
  assert.equal(task.enabled, true);
}));
