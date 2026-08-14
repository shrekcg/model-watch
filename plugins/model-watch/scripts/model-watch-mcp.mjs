#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ENGINE_VERSION, failedResult, normalizeEngineResult } from "../src/engine.mjs";
import { runFixedEvaluator } from "../src/fixed-evaluator.mjs";
import { sameSessionCost } from "../src/cost.mjs";
import { availableModelsForConfig } from "../src/models.mjs";
import { refreshHostCatalog } from "../src/host-catalog.mjs";
import {
  armRouteTicket,
  createRouteTicket,
  getEffectiveConfig,
  loadGlobalConfig,
  loadTaskState,
  mutateTaskState,
  normalizeTaskOverride,
  resolveDataDir,
  updateGlobalConfig
} from "../src/state.mjs";

const SERVER_VERSION = "1.1.2";
const UI_URI = "ui://model-watch/settings-v8.html";
const RECOMMENDATION_UI_URI = "ui://model-watch/recommendation-v1.html";
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
    availableModels: availableModelsForConfig(id ? getEffectiveConfig(id, DATA_DIR) : loadGlobalConfig(DATA_DIR)),
    global: loadGlobalConfig(DATA_DIR),
    task: id ? loadTaskState(id, DATA_DIR) : null,
    effective: id ? getEffectiveConfig(id, DATA_DIR) : loadGlobalConfig(DATA_DIR)
  };
}

function availableModelsForTask(sessionId) {
  return availableModelsForConfig(getEffectiveConfig(sessionId, DATA_DIR));
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
    const allowed = ["autoEnableNewTasks", "showStatusIndicator", "evaluatorMode", "evaluatorModel", "candidateModels", "preferGpt", "externalModelThreshold"];
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

function recordAssessment(args, options = {}) {
  let result;
  const task = mutateTaskState(args.sessionId, (draft) => {
    if (!draft.activeRequest?.turnId || draft.activeRequest.turnId === "unknown" || draft.activeRequest.turnId !== args.turnId) {
      throw new Error("评估结果与当前请求不匹配，已安全放行；请让当前请求重新评估。");
    }
    if (draft.lastAssessment?.turnId === args.turnId) {
      result = draft.lastAssessment;
      return draft;
    }
    result = options.result || normalizeEngineResult({
      status: args.status,
      recommendedModel: args.recommendedModel,
      rationale: args.rationale,
      evaluator: options.evaluator || "same-session",
      confidence: args.confidence,
      signals: args.signals,
      decisionBasis: args.decisionBasis
    }, availableModelsForTask(args.sessionId), draft.activeRequest?.originalModel || draft.currentModel);
    if (args.status === "change" && !draft.activeRequest?.originalModel) {
      result = failedResult("当前模型身份未知，不能形成有效切换建议");
    }
    result.evaluator = options.evaluator || result.evaluator || "same-session";
    result.evaluatorMode = options.evaluatorMode || "same-session";
    result.evaluatorModel = options.evaluatorModel || draft.currentModel;
    result.contextCoverage = options.contextCoverage || "same-session";
    result.requestedEvaluatorModel = options.requestedEvaluatorModel || null;
    result.fallback = options.fallback || null;
    result.startedAt = options.startedAt || null;
    result.finishedAt = options.finishedAt || null;
    result.durationMs = options.durationMs ?? null;
    result.cost = options.cost || sameSessionCost();
    result.source = options.source || "live";
    result.assessmentId = randomUUID();
    result.turnId = draft.activeRequest.turnId;
    result.promptHash = draft.activeRequest.promptHash;
    result.originalModel = draft.activeRequest.originalModel;
    result.availableModels = availableModelsForTask(args.sessionId);
    if (result.source === "test") {
      draft.testHistory = [...(draft.testHistory || []), result].slice(-12);
    } else {
      draft.lastAssessment = result;
      draft.assessmentHistory = [...(draft.assessmentHistory || []), result].slice(-12);
    }
    draft.routeTicket = result.status === "change" && draft.activeRequest?.commandAction !== "check"
      ? createRouteTicket(draft.activeRequest, result.recommendedModel, Date.now(), result.assessmentId, result.source)
      : null;
    return draft;
  }, DATA_DIR);
  return {
    saved: true,
    routeTicketCreated: Boolean(task.routeTicket),
    invalidChange: args.status === "change" && result?.status !== "change",
    task
  };
}

async function runAndRecordFixedEvaluator(args) {
  const task = loadTaskState(args.sessionId, DATA_DIR);
  if (task.activeRequest?.turnId !== args.turnId) throw new Error("固定评估请求与当前输入不匹配。");
  const config = getEffectiveConfig(args.sessionId, DATA_DIR);
  if (config.evaluatorMode !== "fixed-codex") throw new Error("当前未启用固定 Codex 评估器。");
  const result = await runFixedEvaluator({
    prompt: args.prompt,
    currentModel: task.activeRequest.originalModel || task.currentModel,
    availableModels: availableModelsForTask(args.sessionId),
    evaluatorModel: config.evaluatorModel
  });
  if (result.status === "failed") {
    const taskWithAttempt = appendFixedEvaluatorFailure(args, result, config.evaluatorModel);
    return { saved: false, fallbackRequired: true, result, task: taskWithAttempt };
  }
  return recordAssessment({
    sessionId: args.sessionId,
    turnId: args.turnId,
    status: result.status,
    recommendedModel: result.recommendedModel,
    rationale: result.rationale,
    confidence: result.confidence,
    signals: result.signals,
    decisionBasis: result.decisionBasis
  }, {
    result,
    evaluator: "fixed-codex",
    evaluatorMode: "fixed-codex",
    evaluatorModel: config.evaluatorModel,
    contextCoverage: result.contextCoverage,
    requestedEvaluatorModel: config.evaluatorModel,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    cost: result.cost
  });
}

function appendFixedEvaluatorFailure(args, result, requestedEvaluatorModel) {
  return mutateTaskState(args.sessionId, (draft) => {
    if (draft.activeRequest?.turnId !== args.turnId) {
      throw new Error("固定评估结果已过期，未写入记录。");
    }
    const existing = (draft.assessmentHistory || []).find((entry) =>
      entry.turnId === args.turnId &&
      entry.evaluatorMode === "fixed-codex" &&
      entry.evaluatorModel === requestedEvaluatorModel &&
      entry.status === "failed"
    );
    if (existing) return draft;
    const attempt = {
      ...result,
      assessmentId: randomUUID(),
      turnId: draft.activeRequest.turnId,
      promptHash: draft.activeRequest.promptHash,
      originalModel: draft.activeRequest.originalModel,
      availableModels: availableModelsForTask(args.sessionId),
      requestedEvaluatorModel,
      source: "live"
    };
    draft.assessmentHistory = [...(draft.assessmentHistory || []), attempt].slice(-12);
    return draft;
  }, DATA_DIR);
}

function recordFixedEvaluatorFallback(args) {
  return recordAssessment({
    sessionId: args.sessionId,
    turnId: args.turnId,
    status: args.status,
    recommendedModel: args.recommendedModel,
    rationale: args.rationale,
    confidence: args.confidence,
    signals: args.signals,
    decisionBasis: args.decisionBasis
  }, {
    evaluator: "same-session",
    evaluatorMode: "same-session",
    evaluatorModel: args.currentModel,
    requestedEvaluatorModel: args.requestedEvaluatorModel,
    contextCoverage: "same-session",
    fallback: args.fallback,
    cost: sameSessionCost()
  });
}

const TEST_SCENARIOS = new Set([
  "card", "upgrade", "downgrade", "stay", "uncertain", "fixed-fallback", "expired", "unknown-model", "card-ack", "card-ignore"
]);

function createTestRecommendation(args) {
  const task = loadTaskState(args.sessionId, DATA_DIR);
  const currentModel = task.activeRequest?.originalModel || task.currentModel;
  const scenario = normalizeTestScenario(args.scenario);
  if (!currentModel) throw new Error("当前模型未知，无法运行此测试夹具。");
  if (["stay", "uncertain"].includes(scenario)) {
    return recordAssessment({
      sessionId: args.sessionId,
      turnId: args.turnId,
      status: scenario,
      rationale: `这是确定性 ${scenario} 测试，不代表真实模型推荐。`,
      confidence: "high",
      signals: ["用户主动触发内部测试夹具"],
      decisionBasis: ["验证不阻断与测试记录隔离"]
    }, { source: "test", evaluator: "test-fixture", evaluatorMode: "same-session", evaluatorModel: currentModel });
  }
  if (scenario === "fixed-fallback") return createTestFallback(args, currentModel);
  if (scenario === "unknown-model") return createUnknownModelTest(args);
  const recommendedModel = testRecommendedModel(scenario, currentModel, availableModelsForTask(args.sessionId));
  if (!recommendedModel) throw new Error(`测试场景 ${scenario} 与当前模型 ${currentModel} 不匹配；请按测试夹具文档选择起始模型。`);
  return recordAssessment({
    sessionId: args.sessionId,
    turnId: args.turnId,
    status: "change",
    recommendedModel,
    rationale: `这是确定性 ${scenario} 测试，不代表真实模型推荐。`,
    confidence: "high",
    signals: ["用户主动触发内部测试夹具", `fixture:${scenario}`],
    decisionBasis: ["验证卡片、恢复与实际模型记录链路"]
  }, { source: "test", evaluator: "test-fixture", evaluatorMode: "same-session", evaluatorModel: currentModel });
}

function normalizeTestScenario(value) {
  const scenario = String(value || "card").trim().toLowerCase();
  if (!TEST_SCENARIOS.has(scenario)) {
    throw new Error(`未知测试夹具：${scenario}。请查看 docs/testing-fixtures.md。`);
  }
  return scenario;
}

function testRecommendedModel(scenario, currentModel, models) {
  const normalized = String(currentModel).toLowerCase();
  if (scenario === "downgrade") {
    if (normalized === "gpt-5.6-sol" && models.includes("gpt-5.6-terra")) return "gpt-5.6-terra";
    if (normalized === "gpt-5.6-terra" && models.includes("gpt-5.6-luna")) return "gpt-5.6-luna";
    return null;
  }
  if (scenario === "upgrade") {
    if (normalized === "gpt-5.6-luna" && models.includes("gpt-5.6-terra")) return "gpt-5.6-terra";
    if (normalized === "gpt-5.6-terra" && models.includes("gpt-5.6-sol")) return "gpt-5.6-sol";
    return null;
  }
  return models.filter((model) => model.toLowerCase() !== normalized).at(-1) || null;
}

function createTestFallback(args, currentModel) {
  const first = recordAssessment({
    sessionId: args.sessionId, turnId: args.turnId, status: "failed",
    rationale: "这是确定性固定评估失败测试，不代表真实调用错误。",
    confidence: "high", signals: ["fixture:fixed-fallback"], decisionBasis: ["验证失败记录与回退记录分离"]
  }, {
    source: "test", evaluator: "fixed-codex", evaluatorMode: "fixed-codex", evaluatorModel: "gpt-5.6-terra",
    requestedEvaluatorModel: "gpt-5.6-terra", contextCoverage: "current-input-only"
  });
  const second = recordAssessment({
    sessionId: args.sessionId, turnId: args.turnId, status: "stay",
    rationale: "这是确定性同会话回退测试，不代表真实模型推荐。",
    confidence: "high", signals: ["fixture:fixed-fallback"], decisionBasis: ["验证回退后主任务安全放行"]
  }, {
    source: "test", evaluator: "same-session", evaluatorMode: "same-session", evaluatorModel: currentModel,
    requestedEvaluatorModel: "gpt-5.6-terra", contextCoverage: "same-session",
    fallback: { from: "fixed-codex", to: "same-session", reason: "确定性测试模拟固定评估失败", at: new Date().toISOString() }
  });
  return { ...second, fixture: { scenario: "fixed-fallback", first, second } };
}

function createUnknownModelTest(args) {
  const task = mutateTaskState(args.sessionId, (draft) => {
    if (draft.activeRequest?.turnId !== args.turnId) throw new Error("测试夹具与当前输入不匹配。");
    const result = {
      assessmentId: randomUUID(), turnId: draft.activeRequest.turnId, promptHash: draft.activeRequest.promptHash,
      originalModel: null, availableModels: availableModelsForTask(args.sessionId), status: "failed", recommendedModel: null,
      rationale: "这是确定性当前模型未知测试；不得创建切换建议。", evaluator: "test-fixture",
      evaluatorMode: "same-session", evaluatorModel: null, contextCoverage: "same-session", source: "test",
      confidence: "high", signals: ["fixture:unknown-model"], decisionBasis: ["验证模型身份未知时安全失败"],
      engineVersion: ENGINE_VERSION, createdAt: new Date().toISOString()
    };
    draft.testHistory = [...(draft.testHistory || []), result].slice(-12);
    return draft;
  }, DATA_DIR);
  return { saved: true, routeTicketCreated: false, invalidChange: true, task };
}

function recommendationPayload(sessionId, gateId) {
  const task = loadTaskState(sessionId, DATA_DIR);
  const ticket = task.routeTicket;
  const assessment = [...task.assessmentHistory, ...task.testHistory]
    .find((entry) => entry.assessmentId === ticket?.assessmentId);
  if (!ticket || ticket.gateId !== gateId || !assessment || assessment.status !== "change") {
    throw new Error("这条模型建议已失效或不属于当前任务。");
  }
  return {
    sessionId,
    gateId,
    currentModel: ticket.originalModel,
    recommendedModel: ticket.recommendedModel,
    rationale: assessment.rationale,
    source: ticket.source,
    status: ticket.status,
    expiresAt: ticket.expiresAt
  };
}

function prepareResume(args) {
  let prepared;
  const task = mutateTaskState(args.sessionId, (draft) => {
    prepared = armRouteTicket(draft.routeTicket, args);
    if (!prepared) throw new Error("这条模型建议已失效、已被处理或确认请求不匹配。");
    draft.routeTicket = prepared;
    return draft;
  }, DATA_DIR);
  return {
    prepared: true,
    sessionId: args.sessionId,
    gateId: prepared.gateId,
    decision: prepared.explicitDecision,
    resumeNonce: prepared.resumeNonce,
    resumePrompt: `[MODEL_WATCH_RESUME gate=${prepared.gateId} nonce=${prepared.resumeNonce}]`,
    expiresAt: prepared.expiresAt,
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

server.registerTool("model_watch_refresh_host_catalog", {
  description: "只读刷新当前 Codex 桌面可选模型目录与 Codex 限额桶快照。不会修改模型、账号或额度；仅在用户主动刷新时启动短生命周期宿主连接。",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async () => {
  try {
    const hostCatalog = await refreshHostCatalog();
    const global = updateGlobalConfig({ hostCatalog }, DATA_DIR);
    return toolResult("已刷新宿主模型目录与限额快照。", {
      global,
      hostCatalog,
      availableModels: availableModelsForConfig(global)
    });
  } catch (error) {
    return errorResult(`无法刷新宿主目录：${error instanceof Error ? error.message : String(error)}`);
  }
});

server.registerTool("model_watch_record_assessment", {
  description: "保存当前主模型的同会话推荐判断；change 会生成不含正文的短期请求恢复状态。",
  inputSchema: {
    sessionId: z.string(),
    turnId: z.string(),
    status: z.enum(["stay", "change", "uncertain", "failed"]),
    recommendedModel: z.string().nullable().optional(),
    rationale: z.string(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    signals: z.array(z.string()).max(6).optional(),
    decisionBasis: z.array(z.string()).max(4).optional()
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (args) => {
  try { return toolResult("本轮模型判断已保存。", recordAssessment(args)); }
  catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool("model_watch_record_fallback_assessment", {
  description: "仅在固定评估器失败后保存同会话回退判断，并保留失败原因、原请求的评估模型和可用成本信息。",
  inputSchema: {
    sessionId: z.string(), turnId: z.string(), status: z.enum(["stay", "change", "uncertain", "failed"]),
    recommendedModel: z.string().nullable().optional(), rationale: z.string(),
    requestedEvaluatorModel: z.string(), fallbackReason: z.string(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    signals: z.array(z.string()).max(6).optional(), decisionBasis: z.array(z.string()).max(4).optional()
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (args) => {
  try {
    const task = loadTaskState(args.sessionId, DATA_DIR);
    return toolResult("同会话回退判断已保存。", recordFixedEvaluatorFallback({
      ...args,
      currentModel: task.activeRequest?.originalModel || task.currentModel,
      fallback: { from: "fixed-codex", to: "same-session", reason: args.fallbackReason, at: new Date().toISOString() }
    }));
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool("model_watch_get_assessment_records", {
  description: "读取当前任务的真实评估、测试评估、实际模型选择和成本估算记录；不含任务正文或附件。",
  inputSchema: { sessionId: z.string() },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async ({ sessionId }) => {
  try {
    const task = loadTaskState(sessionId, DATA_DIR);
    return toolResult("已读取评估记录。", {
      sessionId,
      records: task.assessmentHistory,
      testRecords: task.testHistory,
      observations: task.observationHistory,
      testObservations: task.testObservationHistory,
      summary: summarizeRecords(task.assessmentHistory)
    });
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

function summarizeRecords(records = []) {
  const totalEstimatedUsd = records.reduce((sum, record) => sum + (record.cost?.estimatedUsd || 0), 0);
  const fixedCount = records.filter((record) => record.evaluatorMode === "fixed-codex").length;
  const fallbackCount = records.filter((record) => record.fallback).length;
  const completedFixedCount = records.filter((record) => record.evaluatorMode === "fixed-codex" && record.status !== "failed").length;
  return { total: records.length, fixedCount, completedFixedCount, fallbackCount, totalEstimatedUsd: Number(totalEstimatedUsd.toFixed(6)) };
}

server.registerTool("model_watch_run_fixed_evaluator", {
  description: "使用设置中的自定义评估模型仅评估本轮精确输入；失败时返回 fallbackRequired，不修改主任务。不会访问历史、附件或工具结果。",
  inputSchema: { sessionId: z.string(), turnId: z.string(), prompt: z.string().min(1).max(12000) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (args) => {
  try {
    const output = await runAndRecordFixedEvaluator(args);
    return toolResult(output.fallbackRequired ? "自定义评估模型不可用，请回退同会话判断。" : "自定义评估结果已保存。", output);
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool("model_watch_create_test_recommendation", {
  description: "仅用于确定性验收：创建不计入真实推荐历史的测试夹具结果。不会评估或执行用户主任务。",
  inputSchema: { sessionId: z.string(), turnId: z.string(), scenario: z.string().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (args) => {
  try { return toolResult("测试建议已创建。", createTestRecommendation(args)); }
  catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool("model_watch_present_recommendation", {
  description: "显示当前任务已经保存的模型切换建议卡片。只读取精确 gate，不修改模型或任务状态。",
  inputSchema: {
    sessionId: z.string(),
    gateId: z.string()
  },
  _meta: {
    ui: { resourceUri: RECOMMENDATION_UI_URI },
    "openai/outputTemplate": RECOMMENDATION_UI_URI,
    "openai/toolInvocation/invoking": "正在打开模型建议",
    "openai/toolInvocation/invoked": "模型建议已打开"
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
}, async (args) => {
  try {
    return toolResult("已打开模型建议。", recommendationPayload(args.sessionId, args.gateId), {
      ui: { resourceUri: RECOMMENDATION_UI_URI }, "openai/outputTemplate": RECOMMENDATION_UI_URI
    });
  } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
});

server.registerTool("model_watch_prepare_resume", {
  description: "记录用户对当前建议的显式决定，并为同一任务生成一次性续跑 nonce；不会切换模型或携带请求正文。",
  inputSchema: {
    sessionId: z.string(),
    gateId: z.string(),
    decision: z.enum(["acknowledged", "ignored"]),
    idempotencyKey: z.string()
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (args) => {
  try { return toolResult("已记录选择，可以继续上一条任务。", prepareResume(args)); }
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

server.registerResource("model-watch-recommendation", RECOMMENDATION_UI_URI, { mimeType: UI_MIME }, async () => ({
  contents: [{
    uri: RECOMMENDATION_UI_URI,
    mimeType: UI_MIME,
    text: readFileSync(resolve(ROOT, "ui", "recommendation.html"), "utf8"),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } }
  }]
}));

await server.connect(new StdioServerTransport());
