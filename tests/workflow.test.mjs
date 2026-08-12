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

function createMcpClient(dataDir) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, MODEL_WATCH_DATA_DIR: dataDir },
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
        status: "change",
        recommendedModel: "gpt-5.6-sol",
        rationale: "本轮需要整合高风险跨系统约束",
        evaluator: "internal-agent"
      }
    });
    assert.equal(recorded.result.structuredContent.routeTicketCreated, true);
    assert.equal(loadTaskState(sessionId, dataDir).lastAssessment.status, "change");
    assert.equal(loadTaskState(sessionId, dataDir).lastAssessment.evaluator, "same-session");

    const resumed = runHook(dataDir, sessionId, prompt, "gpt-5.6-sol");
    assert.match(resumed.hookSpecificOutput.additionalContext, /MODEL_WATCH_ROUTE/);
    assert.match(resumed.hookSpecificOutput.additionalContext, /直接完整执行本轮原始用户请求/);
    const finalState = loadTaskState(sessionId, dataDir);
    assert.equal(finalState.routeTicket, null);
    assert.equal(finalState.observationHistory.at(-1).result, "adopted");

    runHook(dataDir, sessionId, "同模型建议校验", "gpt-5.6-luna");
    const invalid = await client.request("tools/call", {
      name: "model_watch_record_assessment",
      arguments: {
        sessionId,
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
