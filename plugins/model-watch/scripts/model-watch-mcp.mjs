#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  getEffectiveConfig,
  loadGlobalConfig,
  loadTaskState,
  normalizeTaskOverride,
  resolveDataDir,
  saveTaskState,
  updateGlobalConfig,
  validateEffort
} from "../src/state.mjs";

const SERVER_NAME = "model-watch";
const SERVER_VERSION = "1.0.0";
const UI_URI = "ui://model-watch/settings-v1.html";
const UI_MIME = "text/html;profile=mcp-app";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolveDataDir();

const tools = [
  {
    name: "model_watch_open_settings",
    description: "打开模型哨兵设置卡片，并读取全局配置和当前任务状态。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Hook 注入的当前任务 session_id。" }
      },
      required: []
    },
    _meta: {
      ui: { resourceUri: UI_URI },
      "openai/outputTemplate": UI_URI,
      "openai/toolInvocation/invoking": "正在打开模型哨兵设置",
      "openai/toolInvocation/invoked": "模型哨兵设置已打开"
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "model_watch_get_status",
    description: "读取模型哨兵的全局配置、当前任务状态和最终生效配置。",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "model_watch_update_settings",
    description: "更新模型哨兵全局设置或当前任务设置。",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "task"] },
        sessionId: { type: "string" },
        patch: { type: "object", additionalProperties: true }
      },
      required: ["scope", "patch"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: "model_watch_record_assessment",
    description: "保存本轮模型原生判断结果，供下一轮、任务恢复和压缩恢复使用。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        status: { type: "string", enum: ["stay", "change", "uncertain", "failed"] },
        recommendedModel: { type: ["string", "null"] },
        recommendedEffort: {
          type: ["string", "null"],
          enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", null]
        },
        phase: { type: "string" },
        rationale: { type: "string" },
        evaluator: { type: "string", enum: ["main", "independent", "hybrid", "fallback-main"] },
        commandMode: { type: "string", enum: ["automatic", "check", "check-inline", "gate-next"] }
      },
      required: ["sessionId", "status", "phase", "rationale", "evaluator", "commandMode"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }
];

function statusPayload(sessionId) {
  const safeSessionId = sessionId || "unknown";
  return {
    sessionId: safeSessionId,
    global: loadGlobalConfig(DATA_DIR),
    task: loadTaskState(safeSessionId, DATA_DIR),
    effective: getEffectiveConfig(safeSessionId, DATA_DIR)
  };
}

function toolResult(text, structuredContent, meta = undefined) {
  const result = { content: [{ type: "text", text }], structuredContent };
  if (meta) result._meta = meta;
  return result;
}

function errorResult(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function updateSettings(args) {
  const scope = args.scope;
  const patch = args.patch || {};
  if (scope === "global") {
    const allowed = [
      "autoEnableNewTasks",
      "reminderTiming",
      "modelSelection",
      "independentModel",
      "independentEffort"
    ];
    const filtered = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
    updateGlobalConfig(filtered, DATA_DIR);
    return statusPayload(args.sessionId || "unknown");
  }

  if (scope !== "task" || !args.sessionId) throw new Error("当前任务设置需要 sessionId。");
  const task = loadTaskState(args.sessionId, DATA_DIR);
  if ("enabled" in patch) task.enabled = Boolean(patch.enabled);
  if ("currentEffort" in patch) {
    task.currentEffort = validateEffort(patch.currentEffort);
    task.effortSource = "user";
    task.effortPrompted = true;
  }
  if ("effortPrompted" in patch) task.effortPrompted = Boolean(patch.effortPrompted);
  if ("override" in patch) task.override = normalizeTaskOverride(patch.override);
  saveTaskState(args.sessionId, task, DATA_DIR);
  return statusPayload(args.sessionId);
}

function recordAssessment(args) {
  const task = loadTaskState(args.sessionId, DATA_DIR);
  if (args.recommendedEffort !== null && args.recommendedEffort !== undefined) {
    validateEffort(args.recommendedEffort);
  }
  task.lastAssessment = {
    status: args.status,
    recommendedModel: args.recommendedModel || null,
    recommendedEffort: args.recommendedEffort || null,
    phase: String(args.phase).slice(0, 160),
    rationale: String(args.rationale).slice(0, 500),
    evaluator: args.evaluator,
    commandMode: args.commandMode,
    createdAt: new Date().toISOString()
  };
  task.pendingGate = args.commandMode === "gate-next" && args.status === "change"
    ? {
        taskText: task.pendingGate?.taskText || null,
        recommendedModel: task.lastAssessment.recommendedModel,
        recommendedEffort: task.lastAssessment.recommendedEffort,
        rationale: task.lastAssessment.rationale,
        createdAt: task.lastAssessment.createdAt
      }
    : null;
  saveTaskState(args.sessionId, task, DATA_DIR);
  return { saved: true, task: loadTaskState(args.sessionId, DATA_DIR) };
}

async function callTool(name, args) {
  try {
    if (name === "model_watch_open_settings") {
      const payload = statusPayload(args?.sessionId || "unknown");
      return toolResult("已打开模型哨兵设置。", payload, {
        ui: { resourceUri: UI_URI },
        "openai/outputTemplate": UI_URI
      });
    }
    if (name === "model_watch_get_status") {
      const payload = statusPayload(args.sessionId);
      return toolResult("已读取模型哨兵状态。", payload);
    }
    if (name === "model_watch_update_settings") {
      const payload = updateSettings(args);
      return toolResult("模型哨兵设置已保存。", payload);
    }
    if (name === "model_watch_record_assessment") {
      const payload = recordAssessment(args);
      return toolResult("本轮判断已保存。", payload);
    }
    return errorResult(`未知工具：${name}`);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function errorResponse(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    return response(message.id, {
      protocolVersion: message.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Model Watch stores local settings and per-task assessment state."
    });
  }
  if (message.method === "ping") return response(message.id, {});
  if (message.method === "tools/list") return response(message.id, { tools });
  if (message.method === "tools/call") {
    const result = await callTool(message.params?.name, message.params?.arguments || {});
    return response(message.id, result);
  }
  if (message.method === "resources/list") {
    return response(message.id, {
      resources: [{ uri: UI_URI, name: "模型哨兵设置", mimeType: UI_MIME }]
    });
  }
  if (message.method === "resources/read") {
    if (message.params?.uri !== UI_URI) return errorResponse(message.id, -32002, "Resource not found");
    const html = readFileSync(resolve(ROOT, "ui", "settings.html"), "utf8");
    return response(message.id, {
      contents: [{
        uri: UI_URI,
        mimeType: UI_MIME,
        text: html,
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } }
      }]
    });
  }
  if (message.id !== undefined) errorResponse(message.id, -32601, "Method not found");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      try {
        void handleMessage(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`model-watch MCP warning: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    newlineIndex = buffer.indexOf("\n");
  }
});
