import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadTaskState, taskStateExists } from "../plugins/model-watch/src/state.mjs";

const hookPath = resolve(import.meta.dirname, "../plugins/model-watch/scripts/model-watch-hook.mjs");

function runHook(dataDir, input) {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, MODEL_WATCH_DATA_DIR: dataDir }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function withDataDir(run) {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-hook-"));
  try {
    run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("existing task can enable Model Watch after installation", () => withDataDir((dataDir) => {
  const output = runHook(dataDir, {
    hook_event_name: "UserPromptSubmit",
    session_id: "legacy-task",
    model: "gpt-5.6-terra",
    prompt: "$model-watch"
  });
  assert.equal(loadTaskState("legacy-task", dataDir).enabled, true);
  assert.match(output.hookSpecificOutput.additionalContext, /enabled: true/);
  assert.match(output.hookSpecificOutput.additionalContext, /effort_prompt_needed: true/);
}));

test("disabled ordinary task does not create state", () => withDataDir((dataDir) => {
  const output = runHook(dataDir, {
    hook_event_name: "UserPromptSubmit",
    session_id: "quiet-task",
    model: "gpt-5.6-terra",
    prompt: "继续普通任务"
  });
  assert.equal(taskStateExists("quiet-task", dataDir), false);
  assert.equal(output.hookSpecificOutput.additionalContext, "");
}));

test("resumed existing task restores active state", () => withDataDir((dataDir) => {
  runHook(dataDir, {
    hook_event_name: "UserPromptSubmit",
    session_id: "legacy-task",
    prompt: "$model-watch"
  });
  const output = runHook(dataDir, {
    hook_event_name: "SessionStart",
    session_id: "legacy-task",
    source: "resume"
  });
  assert.match(output.hookSpecificOutput.additionalContext, /MODEL_WATCH_RESTORE/);
  assert.match(output.hookSpecificOutput.additionalContext, /session_source: resume/);
}));

test("compaction restores monitoring state", () => withDataDir((dataDir) => {
  runHook(dataDir, {
    hook_event_name: "UserPromptSubmit",
    session_id: "long-task",
    prompt: "$model-watch"
  });
  const output = runHook(dataDir, {
    hook_event_name: "SessionStart",
    session_id: "long-task",
    source: "compact"
  });
  assert.match(output.hookSpecificOutput.additionalContext, /MODEL_WATCH_RESTORE/);
  assert.match(output.hookSpecificOutput.additionalContext, /session_source: compact/);
}));

test("gate-next stores pending task text", () => withDataDir((dataDir) => {
  runHook(dataDir, {
    hook_event_name: "UserPromptSubmit",
    session_id: "gate-task",
    prompt: "$model-watch gate-next，请继续修改登录方案"
  });
  const state = loadTaskState("gate-task", dataDir);
  assert.equal(state.pendingGate.taskText, "请继续修改登录方案");
}));

test("gate decision resumes and clears pending task", () => withDataDir((dataDir) => {
  runHook(dataDir, {
    hook_event_name: "UserPromptSubmit",
    session_id: "gate-resume",
    prompt: "$model-watch gate-next，请继续修改登录方案"
  });
  const output = runHook(dataDir, {
    hook_event_name: "UserPromptSubmit",
    session_id: "gate-resume",
    prompt: "继续"
  });
  assert.match(output.hookSpecificOutput.additionalContext, /pending_gate_task: 请继续修改登录方案/);
  assert.equal(loadTaskState("gate-resume", dataDir).pendingGate, null);
}));
