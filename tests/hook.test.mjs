import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRouteTicket, loadTaskState, saveTaskState, taskStateExists } from "../plugins/model-watch/src/state.mjs";
import { hashPrompt } from "../plugins/model-watch/src/engine.mjs";

const hookPath = resolve(import.meta.dirname, "../plugins/model-watch/scripts/model-watch-hook.mjs");

function runHook(dataDir, input, extraEnv = {}) {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, MODEL_WATCH_DATA_DIR: dataDir, ...extraEnv }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function withDataDir(run) {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-hook-"));
  try { run(dataDir); } finally { rmSync(dataDir, { recursive: true, force: true }); }
}

const promptInput = (sessionId, prompt, model = "gpt-5.6-terra") => ({
  hook_event_name: "UserPromptSubmit",
  session_id: sessionId,
  turn_id: `${sessionId}-turn`,
  model,
  cwd: process.cwd(),
  transcript_path: null,
  permission_mode: "default",
  prompt
});

test("existing task enables the generic pre-task engine", () => withDataDir((dataDir) => {
  const enabled = runHook(dataDir, promptInput("legacy-task", "$model-watch"));
  assert.equal(loadTaskState("legacy-task", dataDir).enabled, true);
  assert.match(enabled.hookSpecificOutput.additionalContext, /MODEL_WATCH_CONTROL 2\.0\.0/);
  const output = runHook(dataDir, promptInput("legacy-task", "请分析今天的工作安排"));
  assert.match(output.hookSpecificOutput.additionalContext, /MODEL_WATCH_CONTEXT 2\.0\.0/);
  assert.match(output.hookSpecificOutput.additionalContext, /session_id: legacy-task/);
  assert.match(output.hookSpecificOutput.additionalContext, /每一条真实用户请求/);
  assert.match(output.hookSpecificOutput.additionalContext, /stay、change、uncertain 和 failed 都要保存/);
  assert.match(output.hookSpecificOutput.additionalContext, /available_models: gpt-5\.6-luna, gpt-5\.6-terra, gpt-5\.6-sol/);
  assert.match(output.hookSpecificOutput.additionalContext, /日常沟通/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /推理深度/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /reminder_timing|evaluator_mode/);
}));

test("disabled ordinary task exits without state", () => withDataDir((dataDir) => {
  const output = runHook(dataDir, promptInput("quiet-task", "继续普通任务"));
  assert.equal(taskStateExists("quiet-task", dataDir), false);
  assert.equal(output.hookSpecificOutput.additionalContext, "");
}));

test("resume and compaction restore monitoring", () => withDataDir((dataDir) => {
  runHook(dataDir, promptInput("long-task", "$model-watch"));
  for (const source of ["resume", "compact"]) {
    const output = runHook(dataDir, { hook_event_name: "SessionStart", session_id: "long-task", source });
    assert.match(output.hookSpecificOutput.additionalContext, /MODEL_WATCH_RESTORE/);
  }
}));

test("uses the SessionStart model when a later prompt omits it", () => withDataDir((dataDir) => {
  runHook(dataDir, promptInput("model-fallback", "$model-watch"));
  runHook(dataDir, {
    hook_event_name: "SessionStart",
    session_id: "model-fallback",
    source: "resume",
    model: "gpt-5.6-luna"
  });
  const output = runHook(dataDir, {
    hook_event_name: "UserPromptSubmit",
    session_id: "model-fallback",
    turn_id: "model-fallback-next",
    prompt: "继续普通任务"
  });
  assert.equal(loadTaskState("model-fallback", dataDir).activeRequest.originalModel, "gpt-5.6-luna");
  assert.match(output.hookSpecificOutput.additionalContext, /current_model: gpt-5\.6-luna/);
}));

test("pause bypasses evaluation and shows the paused marker", () => withDataDir((dataDir) => {
  runHook(dataDir, promptInput("pause-task", "$model-watch"));
  runHook(dataDir, promptInput("pause-task", "$model-watch pause"));
  const output = runHook(dataDir, promptInput("pause-task", "继续正常工作"));
  assert.equal(loadTaskState("pause-task", dataDir).paused, true);
  assert.match(output.hookSpecificOutput.additionalContext, /🛰️⏸️/u);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /推荐引擎/);
}));

test("matching route ticket skips repeat evaluation and records actual model", () => withDataDir((dataDir) => {
  const prompt = "请继续修改登录方案";
  const task = loadTaskState("route-task", dataDir);
  task.enabled = true;
  task.routeTicket = createRouteTicket({
    turnId: "old-turn",
    promptHash: hashPrompt(prompt),
    originalModel: "gpt-5.6-terra"
  }, "gpt-5.6-sol");
  saveTaskState("route-task", task, dataDir);
  const output = runHook(dataDir, promptInput("route-task", prompt, "gpt-5.6-sol"));
  assert.match(output.hookSpecificOutput.additionalContext, /MODEL_WATCH_ROUTE/);
  const after = loadTaskState("route-task", dataDir);
  assert.equal(after.routeTicket, null);
  assert.equal(after.observationHistory.at(-1).result, "adopted");
}));

test("a different request supersedes the pending recommendation", () => withDataDir((dataDir) => {
  const task = loadTaskState("superseded-task", dataDir);
  task.enabled = true;
  task.routeTicket = createRouteTicket({
    turnId: "old-turn",
    promptHash: hashPrompt("原请求"),
    originalModel: "gpt-5.6-terra"
  }, "gpt-5.6-sol");
  saveTaskState("superseded-task", task, dataDir);
  const output = runHook(dataDir, promptInput("superseded-task", "全新请求", "gpt-5.6-terra"));
  assert.match(output.hookSpecificOutput.additionalContext, /MODEL_WATCH_CONTEXT/);
  const after = loadTaskState("superseded-task", dataDir);
  assert.equal(after.observationHistory.at(-1).result, "superseded");
  assert.equal(after.routeTicket, null);
}));

test("removed command is handled without running the recommendation engine", () => withDataDir((dataDir) => {
  runHook(dataDir, promptInput("unknown-command", "$model-watch"));
  const output = runHook(dataDir, promptInput("unknown-command", "$model-watch gate-next，请继续"));
  assert.match(output.hookSpecificOutput.additionalContext, /MODEL_WATCH_CONTROL/);
  assert.match(output.hookSpecificOutput.additionalContext, /已不存在或无法识别/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /通用的推荐引擎/);
}));
