import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_GLOBAL_CONFIG,
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
  assert.equal("independentEffort" in loadGlobalConfig(dataDir), false);
}));

test("task status-indicator override wins over the global setting", () => withDataDir((dataDir) => {
  updateGlobalConfig({ showStatusIndicator: true }, dataDir);
  const task = loadTaskState("task-1", dataDir);
  task.override = { showStatusIndicator: false };
  saveTaskState("task-1", task, dataDir);
  const effective = getEffectiveConfig("task-1", dataDir);
  assert.equal(effective.showStatusIndicator, false);
  assert.equal("reminderTiming" in effective, false);
  assert.equal("evaluatorMode" in effective, false);
}));

test("legacy routing settings are ignored during config migration", () => withDataDir((dataDir) => {
  const migrated = updateGlobalConfig({
    reminderTiming: "manual",
    evaluatorMode: "external-api",
    externalBaseUrl: "https://example.com/v1"
  }, dataDir);
  assert.deepEqual(migrated, DEFAULT_GLOBAL_CONFIG);
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
