#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ENGINE_VERSION, failedResult, normalizeEngineResult } from "../src/engine.mjs";
import { availableModelsFromEnv } from "../src/models.mjs";
import {
  createRouteTicket,
  getEffectiveConfig,
  loadGlobalConfig,
  loadTaskState,
  mutateTaskState,
  normalizeTaskOverride,
  resolveDataDir,
  updateGlobalConfig
} from "../src/state.mjs";

const SERVER_VERSION = "1.1.1";
const UI_URI = "ui://model-watch/settings-v5.html";
const UI_MIME = "text/html;profile=mcp-app";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolveDataDir(process.env, ROOT);
function statusPayload(sessionId) {
  const id = typeof sessionId === "string" && sessionId.trim() && sessionId !== "unknown"
    ? sessionId.trim()
    : null;
  return {
    sessionId: id,
    engineVersion: ENGINE_VERSION,
    availableModels: availableModelsFromEnv(),
    global: loadGlobalConfig(DATA_DIR),
    task: id ? loadTaskState(id, DATA_DIR) : null,
    effective: id ? getEffectiveConfig(id, DATA_DIR) : loadGlobalConfig(DATA_DIR)
  };
}

function toolResult(text, structuredContent, meta) {
  const result = { content: [{ type: "text", text }], structuredContent };
  if (meta) result._meta = meta;
  return result;
}

function errorResult(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function updateSettings(args) {
  const patch = args.patch || {};
  if (args.scope === "global") {
    const allowed = ["autoEnableNewTasks", "showStatusIndicator"];
    updateGlobalConfig(Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key))), DATA_DIR);
    return statusPayload(args.sessionId);
  }
  if (args.scope !== "task" || !args.sessionId || args.sessionId === "unknown") {
    throw new Error("当前任务设置需要 Hook 提供的精确 sessionId。");
  }
  mutateTaskState(args.sessionId, (task) => {
    if ("enabled" in patch) task.enabled = Boolean(patch.enabled);
    if ("paused" in patch) task.paused = Boolean(patch.paused);
    if ("override" in patch) task.override = normalizeTaskOverride(patch.override);
    return task;
  }, DATA_DIR);
  return statusPayload(args.sessionId);
}

function recordAssessment(args) {
  let result;
  const task = mutateTaskState(args.sessionId, (draft) => {
    if (!draft.activeRequest?.turnId || draft.activeRequest.turnId === "unknown" || draft.activeRequest.turnId !== args.turnId) {
      throw new Error("评估结果与当前请求不匹配，已安全放行；请让当前请求重新评估。");
    }
    result = normalizeEngineResult({
      status: args.status,
      recommendedModel: args.recommendedModel,
      rationale: args.rationale,
      evaluator: "same-session"
    }, availableModelsFromEnv(), draft.activeRequest?.originalModel || draft.currentModel);
    if (args.status === "change" && !draft.activeRequest?.originalModel) {
      result = failedResult("当前模型身份未知，不能形成有效切换建议");
    }
    result.evaluator = "same-session";
    result.assessmentId = randomUUID();
    result.turnId = draft.activeRequest.turnId;
    result.promptHash = draft.activeRequest.promptHash;
    result.originalModel = draft.activeRequest.originalModel;
    result.availableModels = availableModelsFromEnv();
    draft.lastAssessment = result;
    draft.assessmentHistory = [...(draft.assessmentHistory || []), result].slice(-12);
    draft.routeTicket = result.status === "change" && draft.activeRequest?.commandAction !== "check"
      ? createRouteTicket(draft.activeRequest, result.recommendedModel, Date.now(), result.assessmentId)
      : null;
    return draft;
  }, DATA_DIR);
  return {
    saved: true,
    routeTicketCreated: Boolean(task.routeTicket),
    invalidChange: args.status === "change" && result.status !== "change",
    task
  };
}

const server = new McpServer(
  { name: "model-watch", version: SERVER_VERSION },
  { instructions: "Model Watch uses only the current main-model same-session evaluator. It stores local settings, request hashes, and model metadata without task text." }
);

server.registerTool("model_watch_open_settings", {
  description: "打开模型哨兵设置卡片，并读取全局配置和当前任务状态。",
  inputSchema: { sessionId: z.string().optional() },
  _meta: {
    ui: { resourceUri: UI_URI },
    "openai/outputTemplate": UI_URI,
    "openai/toolInvocation/invoking": "正在打开模型哨兵设置",
    "openai/toolInvocation/invoked": "模型哨兵设置已打开"
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async (args) => toolResult("已打开模型哨兵设置。", statusPayload(args.sessionId), {
  ui: { resourceUri: UI_URI }, "openai/outputTemplate": UI_URI
}));

server.registerTool("model_watch_get_status", {
  description: "读取模型哨兵的全局配置、当前任务状态和最终生效配置。",
  inputSchema: { sessionId: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async (args) => toolResult("已读取模型哨兵状态。", statusPayload(args.sessionId)));

server.registerTool("model_watch_update_settings", {
  description: "更新模型哨兵全局设置或当前任务设置。",
  inputSchema: {
    scope: z.enum(["global", "task"]),
    sessionId: z.string().optional(),
    patch: z.record(z.string(), z.unknown())
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (args) => {
  try { return toolResult("模型哨兵设置已保存。", updateSettings(args)); }
  catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool("model_watch_record_assessment", {
  description: "保存当前主模型的同会话推荐判断；change 会生成不含正文的短期请求恢复状态。",
  inputSchema: {
    sessionId: z.string(),
    turnId: z.string(),
    status: z.enum(["stay", "change", "uncertain", "failed"]),
    recommendedModel: z.string().nullable().optional(),
    rationale: z.string()
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (args) => {
  try { return toolResult("本轮模型判断已保存。", recordAssessment(args)); }
  catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerResource("model-watch-settings", UI_URI, { mimeType: UI_MIME }, async () => ({
  contents: [{
    uri: UI_URI,
    mimeType: UI_MIME,
    text: readFileSync(resolve(ROOT, "ui", "settings.html"), "utf8"),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } }
  }]
}));

await server.connect(new StdioServerTransport());
