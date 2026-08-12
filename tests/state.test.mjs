import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_GLOBAL_CONFIG,
  getEffectiveConfig,
  loadGlobalConfig,
  loadTaskState,
  resolveLatestTaskSession,
  resolveDataDir,
  saveTaskState,
  updateGlobalConfig
} from "../plugins/model-watch/src/state.mjs";

function withDataDir(run) {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-state-"));
  try {
    run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("uses safe defaults with new-task auto enable off", () => withDataDir((dataDir) => {
  assert.deepEqual(loadGlobalConfig(dataDir), DEFAULT_GLOBAL_CONFIG);
  assert.equal(loadTaskState("old-task", dataDir).enabled, false);
}));

test("task override wins over global config", () => withDataDir((dataDir) => {
  updateGlobalConfig({ reminderTiming: "every-turn", modelSelection: "hybrid" }, dataDir);
  const task = loadTaskState("task-1", dataDir);
  task.override = { reminderTiming: "manual", modelSelection: "main" };
  saveTaskState("task-1", task, dataDir);
  const effective = getEffectiveConfig("task-1", dataDir);
  assert.equal(effective.reminderTiming, "manual");
  assert.equal(effective.modelSelection, "main");
}));

test("state path sanitizes session ids", () => withDataDir((dataDir) => {
  const task = loadTaskState("../../unsafe/session", dataDir);
  task.enabled = true;
  const saved = saveTaskState("../../unsafe/session", task, dataDir);
  assert.equal(saved.sessionId.includes("/"), false);
}));

test("resolves the most recently updated task when the UI has no session id", () => withDataDir((dataDir) => {
  saveTaskState("older-task", loadTaskState("older-task", dataDir), dataDir);
  saveTaskState("current-task", { ...loadTaskState("current-task", dataDir), enabled: true }, dataDir);
  assert.equal(resolveLatestTaskSession(dataDir), "current-task");
}));

test("bundled MCP and hooks resolve the same plugin data directory", () => {
  const pluginData = join(tmpdir(), "codex-home", "plugins", "data", "model-watch-model-watch");
  const cacheRoot = join(
    tmpdir(),
    "codex-home",
    "plugins",
    "cache",
    "model-watch",
    "model-watch",
    "1.0.1"
  );
  assert.equal(resolveDataDir({}, cacheRoot), pluginData);
  assert.equal(resolveDataDir({ PLUGIN_DATA: pluginData }, "/unrelated"), pluginData);
});
