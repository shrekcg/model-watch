import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { loadTaskState } from "../plugins/model-watch/src/state.mjs";

const hookPath = resolve(import.meta.dirname, "../plugins/model-watch/scripts/model-watch-hook.mjs");
const serverPath = resolve(import.meta.dirname, "../plugins/model-watch/scripts/model-watch-mcp.mjs");

function runHook(dataDir, sessionId, prompt, model = "gpt-5.6-terra") {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: `${sessionId}-${Date.now()}`,
      model,
      prompt
    }),
    encoding: "utf8",
    env: { ...process.env, MODEL_WATCH_DATA_DIR: dataDir }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function createMcpClient(dataDir, envPatch = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...envPatch, MODEL_WATCH_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map();
  let buffer = "";
  let id = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
      newline = buffer.indexOf("\n");
    }
  });
  return {
    child,
    request(method, params) {
      const requestId = id++;
      return new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error(`MCP timeout for ${method}`)), 3000);
        pending.set(requestId, (message) => {
          clearTimeout(timeout);
          resolvePromise(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      });
    }
  };
}

test("single-path workflow enables, assesses, interrupts and resumes the same request", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-workflow-"));
  const sessionId = "workflow-task";
  const prompt = "继续检查登录、支付和订单状态一致性";
  const client = createMcpClient(dataDir);
  try {
    runHook(dataDir, sessionId, "$model-watch");
    const assessmentTurn = runHook(dataDir, sessionId, prompt);
    const context = assessmentTurn.hookSpecificOutput.additionalContext;
    assert.match(context, /session_id: workflow-task/);
    assert.match(context, /每一条真实用户请求/);

    const recorded = await client.request("tools/call", {
      name: "model_watch_record_assessment",
      arguments: {
        sessionId,
        turnId: loadTaskState(sessionId, dataDir).activeRequest.turnId,
        status: "change",
        recommendedModel: "gpt-5.6-sol",
        rationale: "本轮需要整合高风险跨系统约束",
        evaluator: "internal-agent"
      }
    });
    assert.equal(recorded.result.structuredContent.routeTicketCreated, true);
    assert.equal(loadTaskState(sessionId, dataDir).lastAssessment.status, "change");
    assert.equal(loadTaskState(sessionId, dataDir).lastAssessment.evaluator, "same-session");
    assert.equal(loadTaskState(sessionId, dataDir).assessmentHistory.length, 1);
    assert.equal(loadTaskState(sessionId, dataDir).assessmentHistory[0].promptHash.length, 64);
    assert.equal(JSON.stringify(loadTaskState(sessionId, dataDir).assessmentHistory).includes(prompt), false);

    const duplicate = await client.request("tools/call", {
      name: "model_watch_record_assessment",
      arguments: {
        sessionId,
        turnId: loadTaskState(sessionId, dataDir).activeRequest.turnId,
        status: "stay",
        rationale: "重复调用不应覆盖首个判断"
      }
    });
    assert.equal(duplicate.result.structuredContent.task.assessmentHistory.length, 1);
    assert.equal(duplicate.result.structuredContent.task.routeTicket.gateId, recorded.result.structuredContent.task.routeTicket.gateId);

    const resumed = runHook(dataDir, sessionId, prompt, "gpt-5.6-sol");
    assert.match(resumed.hookSpecificOutput.additionalContext, /MODEL_WATCH_ROUTE/);
    assert.match(resumed.hookSpecificOutput.additionalContext, /直接完整执行本轮原始用户请求/);
    const finalState = loadTaskState(sessionId, dataDir);
    assert.equal(finalState.routeTicket, null);
    assert.equal(finalState.observationHistory.at(-1).result, "adopted");
    assert.equal(finalState.observationHistory.at(-1).assessmentId, finalState.assessmentHistory[0].assessmentId);

    runHook(dataDir, sessionId, "同模型建议校验", "gpt-5.6-luna");
    const invalid = await client.request("tools/call", {
      name: "model_watch_record_assessment",
      arguments: {
        sessionId,
        turnId: loadTaskState(sessionId, dataDir).activeRequest.turnId,
        status: "change",
        recommendedModel: "gpt-5.6-luna",
        rationale: "不应推荐当前模型",
        evaluator: "same-session"
      }
    });
    assert.equal(invalid.result.structuredContent.routeTicketCreated, false);
    assert.equal(invalid.result.structuredContent.invalidChange, true);
    assert.equal(loadTaskState(sessionId, dataDir).lastAssessment.status, "failed");
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a late assessment cannot overwrite a newer request", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-stale-turn-"));
  const sessionId = "stale-turn-task";
  const client = createMcpClient(dataDir);
  try {
    runHook(dataDir, sessionId, "!model-watch on");
    const firstTurn = runHook(dataDir, sessionId, "第一条请求");
    const firstTurnId = loadTaskState(sessionId, dataDir).activeRequest.turnId;
    assert.match(firstTurn.hookSpecificOutput.additionalContext, /turn_id:/);
    runHook(dataDir, sessionId, "第二条请求");
    const late = await client.request("tools/call", {
      name: "model_watch_record_assessment",
      arguments: {
        sessionId,
        turnId: firstTurnId,
        status: "change",
        recommendedModel: "gpt-5.6-sol",
        rationale: "迟到结果不应写入新请求"
      }
    });
    assert.equal(late.result.structuredContent, undefined);
    assert.match(late.result.content[0].text, /与当前请求不匹配/);
    assert.equal(loadTaskState(sessionId, dataDir).assessmentHistory.length, 0);
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a change from check does not create a resumable task ticket", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-check-only-"));
  const sessionId = "check-only-task";
  const client = createMcpClient(dataDir);
  try {
    runHook(dataDir, sessionId, "!model-watch on");
    runHook(dataDir, sessionId, "!model-watch check");
    const recorded = await client.request("tools/call", {
      name: "model_watch_record_assessment",
      arguments: {
        sessionId,
        turnId: loadTaskState(sessionId, dataDir).activeRequest.turnId,
        status: "change",
        recommendedModel: "gpt-5.6-sol",
        rationale: "只检查命令没有待执行主任务"
      }
    });
    assert.equal(recorded.result.structuredContent.routeTicketCreated, false);
    assert.equal(loadTaskState(sessionId, dataDir).routeTicket, null);
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("recommendation card prepares one opaque resume and the hook executes the prior task route", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-card-resume-"));
  const sessionId = "card-workflow-task";
  const prompt = "执行需要切换模型的完整审计任务";
  const client = createMcpClient(dataDir);
  try {
    runHook(dataDir, sessionId, "!model-watch on", "gpt-5.6-luna");
    runHook(dataDir, sessionId, prompt, "gpt-5.6-luna");
    const active = loadTaskState(sessionId, dataDir).activeRequest;
    const recorded = await client.request("tools/call", {
      name: "model_watch_record_assessment",
      arguments: {
        sessionId,
        turnId: active.turnId,
        status: "change",
        recommendedModel: "gpt-5.6-sol",
        rationale: "需要更强的跨文件风险审计能力"
      }
    });
    const gateId = recorded.result.structuredContent.task.routeTicket.gateId;
    const presented = await client.request("tools/call", {
      name: "model_watch_present_recommendation",
      arguments: { sessionId, gateId }
    });
    assert.equal(presented.result.structuredContent.recommendedModel, "gpt-5.6-sol");

    const prepared = await client.request("tools/call", {
      name: "model_watch_prepare_resume",
      arguments: {
        sessionId,
        gateId,
        decision: "acknowledged",
        idempotencyKey: "workflow-click-1"
      }
    });
    const resumePrompt = prepared.result.structuredContent.resumePrompt;
    assert.match(resumePrompt, /^\[MODEL_WATCH_RESUME gate=/);
    assert.equal(resumePrompt.includes(prompt), false);

    const repeated = await client.request("tools/call", {
      name: "model_watch_prepare_resume",
      arguments: {
        sessionId,
        gateId,
        decision: "acknowledged",
        idempotencyKey: "workflow-click-1"
      }
    });
    assert.equal(repeated.result.structuredContent.resumeNonce, prepared.result.structuredContent.resumeNonce);

    const resumed = runHook(dataDir, sessionId, resumePrompt, "gpt-5.6-sol");
    assert.match(resumed.hookSpecificOutput.additionalContext, /上一条真实用户请求/);
    const finalState = loadTaskState(sessionId, dataDir);
    assert.equal(finalState.routeTicket, null);
    assert.equal(finalState.observationHistory.at(-1).explicitDecision, "acknowledged");
    assert.equal(finalState.observationHistory.at(-1).result, "adopted");
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("deterministic test card is isolated from live assessment history", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-test-card-"));
  const sessionId = "test-card-task";
  const client = createMcpClient(dataDir);
  try {
    runHook(dataDir, sessionId, "!model-watch on", "gpt-5.6-luna");
    runHook(dataDir, sessionId, "!model-watch test-card", "gpt-5.6-luna");
    const active = loadTaskState(sessionId, dataDir).activeRequest;
    const created = await client.request("tools/call", {
      name: "model_watch_create_test_recommendation",
      arguments: { sessionId, turnId: active.turnId }
    });
    const state = created.result.structuredContent.task;
    assert.equal(state.assessmentHistory.length, 0);
    assert.equal(state.testHistory.length, 1);
    assert.equal(state.observationHistory.length, 0);
    assert.equal(state.routeTicket.source, "test");
    assert.equal(state.routeTicket.recommendedModel, "gpt-5.6-sol");
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("deterministic downgrade fixture records a downward recommendation without using the live engine", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-test-downgrade-"));
  const sessionId = "test-downgrade-task";
  const client = createMcpClient(dataDir);
  try {
    runHook(dataDir, sessionId, "!model-watch on", "gpt-5.6-sol");
    const output = runHook(dataDir, sessionId, "!model-watch test downgrade", "gpt-5.6-sol");
    assert.match(output.hookSpecificOutput.additionalContext, /场景为 downgrade/);
    const active = loadTaskState(sessionId, dataDir).activeRequest;
    const created = await client.request("tools/call", {
      name: "model_watch_create_test_recommendation",
      arguments: { sessionId, turnId: active.turnId, scenario: "downgrade" }
    });
    const record = created.result.structuredContent.task.testHistory.at(-1);
    assert.equal(record.status, "change");
    assert.equal(record.recommendedModel, "gpt-5.6-terra");
    assert.equal(record.changeDirection, "down");
    assert.equal(created.result.structuredContent.task.assessmentHistory.length, 0);
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("deterministic fixed-fallback fixture records both isolated test attempts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-test-fallback-"));
  const sessionId = "test-fallback-task";
  const client = createMcpClient(dataDir);
  try {
    runHook(dataDir, sessionId, "!model-watch on", "gpt-5.6-terra");
    runHook(dataDir, sessionId, "!model-watch test fixed-fallback", "gpt-5.6-terra");
    const active = loadTaskState(sessionId, dataDir).activeRequest;
    const created = await client.request("tools/call", {
      name: "model_watch_create_test_recommendation",
      arguments: { sessionId, turnId: active.turnId, scenario: "fixed-fallback" }
    });
    const history = created.result.structuredContent.task.testHistory;
    assert.equal(history.length, 2);
    assert.equal(history[0].status, "failed");
    assert.equal(history[1].fallback.to, "same-session");
    assert.equal(created.result.structuredContent.task.assessmentHistory.length, 0);
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("fixed evaluator fallback is persisted as same-session with a clear audit trail", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-fixed-fallback-"));
  const sessionId = "fixed-fallback-task";
  const client = createMcpClient(dataDir, { MODEL_WATCH_FIXED_EVALUATOR_RESULT: "not-json" });
  try {
    await client.request("tools/call", {
      name: "model_watch_update_settings",
      arguments: {
        scope: "global",
        patch: { evaluatorMode: "fixed-codex", evaluatorModel: "gpt-5.6-terra" }
      }
    });
    runHook(dataDir, sessionId, "!model-watch on", "gpt-5.6-luna");
    runHook(dataDir, sessionId, "需要高风险审计，但固定评估器超时", "gpt-5.6-luna");
    const active = loadTaskState(sessionId, dataDir).activeRequest;
    const fixed = await client.request("tools/call", {
      name: "model_watch_run_fixed_evaluator",
      arguments: { sessionId, turnId: active.turnId, prompt: "需要高风险审计，但固定评估器超时" }
    });
    assert.equal(fixed.result.structuredContent.fallbackRequired, true);
    const fallback = await client.request("tools/call", {
      name: "model_watch_record_fallback_assessment",
      arguments: {
        sessionId,
        turnId: active.turnId,
        status: "stay",
        rationale: "当前主模型已完成同会话回退判断",
        requestedEvaluatorModel: "gpt-5.6-terra",
        fallbackReason: "固定评估器超时，已回退同会话判断"
      }
    });
    const record = fallback.result.structuredContent.task.lastAssessment;
    const history = fallback.result.structuredContent.task.assessmentHistory;
    assert.equal(record.evaluatorModel, "gpt-5.6-luna");
    assert.equal(record.requestedEvaluatorModel, "gpt-5.6-terra");
    assert.equal(record.fallback.from, "fixed-codex");
    assert.equal(record.fallback.to, "same-session");
    assert.equal(record.cost.estimatedUsd, null);
    assert.equal(history.length, 2);
    assert.equal(history[0].evaluatorMode, "fixed-codex");
    assert.equal(history[0].status, "failed");
    assert.equal(history[0].cost.estimatedUsd, null);

    const records = await client.request("tools/call", {
      name: "model_watch_get_assessment_records",
      arguments: { sessionId }
    });
    assert.equal(records.result.structuredContent.summary.fallbackCount, 1);
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
