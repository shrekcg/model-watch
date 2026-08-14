import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { changeDirection, modelIdsEqual } from "./models.mjs";

export const DEFAULT_GLOBAL_CONFIG = Object.freeze({
  schemaVersion: 9,
  autoEnableNewTasks: false,
  showStatusIndicator: true,
  evaluatorMode: "same-session",
  evaluatorModel: "gpt-5.6-terra",
  candidateModels: null,
  preferGpt: true,
  externalModelThreshold: 30,
  hostCatalog: null
});

const ASSESSMENT_STATUSES = new Set(["stay", "change", "uncertain", "failed"]);
const OBSERVATION_RESULTS = new Set(["adopted", "kept", "other", "superseded", "expired", "cancelled"]);
const HISTORY_LIMIT = 12;
const GATE_STATUSES = new Set(["waiting", "armed"]);
const EXPLICIT_DECISIONS = new Set(["acknowledged", "ignored"]);
const EVALUATOR_MODES = new Set(["same-session", "fixed-codex"]);
const TICKET_TTL_MS = 15 * 60 * 1000;
const LOCK_WAIT_MS = 5_000;
const INVALID_LOCK_STALE_MS = 30_000;

function inferPluginDataDir(cwd) {
  const absoluteCwd = resolve(cwd);
  const root = parse(absoluteCwd).root;
  const parts = relative(root, absoluteCwd).split(sep).filter(Boolean);
  const cacheIndex = parts.lastIndexOf("cache");
  if (
    cacheIndex < 1 ||
    parts[cacheIndex - 1] !== "plugins" ||
    !parts[cacheIndex + 1] ||
    !parts[cacheIndex + 2]
  ) return null;
  return join(
    root,
    ...parts.slice(0, cacheIndex),
    "data",
    `${parts[cacheIndex + 1]}-${parts[cacheIndex + 2]}`
  );
}

export function resolveDataDir(env = process.env, cwd = process.cwd()) {
  const configured = env.MODEL_WATCH_DATA_DIR || env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  const inferred = inferPluginDataDir(cwd);
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  return resolve(cwd, configured || inferred || join(codexHome, "model-watch"));
}

export function sanitizeSessionId(sessionId) {
  const value = String(sessionId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  return value.slice(0, 160) || "unknown";
}

function globalPath(dataDir) {
  return join(dataDir, "global.json");
}

function taskPath(dataDir, sessionId) {
  return join(dataDir, "tasks", `${sanitizeSessionId(sessionId)}.json`);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function withFileLock(path, run) {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomUUID();
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) throw error;
      if (canRemoveStaleLock(lockPath)) {
        try { unlinkSync(lockPath); } catch { /* another waiter or owner won the race */ }
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return run();
  } finally {
    closeSync(descriptor);
    try {
      const owner = readJson(lockPath, null);
      if (owner?.token === token) unlinkSync(lockPath);
    } catch { /* another process owns or cleared the lock */ }
  }
}

function canRemoveStaleLock(lockPath) {
  const owner = readJson(lockPath, null);
  if (Number.isInteger(owner?.pid) && owner.pid > 0) return !isProcessAlive(owner.pid);
  try { return Date.now() - statSync(lockPath).mtimeMs > INVALID_LOCK_STALE_MS; }
  catch { return false; }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function loadGlobalConfig(dataDir = resolveDataDir()) {
  const stored = readJson(globalPath(dataDir), {});
  return normalizeGlobalConfig({ ...DEFAULT_GLOBAL_CONFIG, ...stored });
}

export function saveGlobalConfig(config, dataDir = resolveDataDir()) {
  const normalized = normalizeGlobalConfig(config);
  withFileLock(globalPath(dataDir), () => writeJsonAtomic(globalPath(dataDir), normalized));
  return normalized;
}

export function updateGlobalConfig(patch, dataDir = resolveDataDir()) {
  return withFileLock(globalPath(dataDir), () => {
    const normalized = normalizeGlobalConfig({ ...loadGlobalConfig(dataDir), ...patch });
    writeJsonAtomic(globalPath(dataDir), normalized);
    return normalized;
  });
}

export function createTaskState(sessionId, enabled = false) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 9,
    sessionId: sanitizeSessionId(sessionId),
    enabled: Boolean(enabled),
    paused: false,
    override: null,
    currentModel: null,
    activeRequest: null,
    routeTicket: null,
    lastAssessment: null,
    assessmentHistory: [],
    testHistory: [],
    observationHistory: [],
    testObservationHistory: [],
    createdAt: now,
    updatedAt: now
  };
}

export function loadTaskState(sessionId, dataDir = resolveDataDir()) {
  const fallback = createTaskState(sessionId, loadGlobalConfig(dataDir).autoEnableNewTasks);
  return normalizeTaskState(
    { ...fallback, ...readJson(taskPath(dataDir, sessionId), fallback) },
    sessionId
  );
}

export function taskStateExists(sessionId, dataDir = resolveDataDir()) {
  try {
    readFileSync(taskPath(dataDir, sessionId));
    return true;
  } catch {
    return false;
  }
}

export function saveTaskState(sessionId, state, dataDir = resolveDataDir()) {
  const normalized = normalizeTaskState(state, sessionId);
  withFileLock(taskPath(dataDir, sessionId), () => writeJsonAtomic(taskPath(dataDir, sessionId), normalized));
  return normalized;
}

export function mutateTaskState(sessionId, mutate, dataDir = resolveDataDir()) {
  const path = taskPath(dataDir, sessionId);
  return withFileLock(path, () => {
    const current = loadTaskState(sessionId, dataDir);
    const next = normalizeTaskState(mutate(structuredClone(current)) || current, sessionId);
    writeJsonAtomic(path, next);
    return next;
  });
}

export function updateTaskState(sessionId, patch, dataDir = resolveDataDir()) {
  return mutateTaskState(sessionId, (task) => ({ ...task, ...patch }), dataDir);
}

export function getEffectiveConfig(sessionId, dataDir = resolveDataDir()) {
  const global = loadGlobalConfig(dataDir);
  const task = loadTaskState(sessionId, dataDir);
  return normalizeGlobalConfig({ ...global, ...(task.override || {}) });
}

export function normalizeGlobalConfig(config) {
  const hostCatalog = normalizeHostCatalog(config.hostCatalog);
  return {
    schemaVersion: 9,
    autoEnableNewTasks: Boolean(config.autoEnableNewTasks),
    showStatusIndicator: config.showStatusIndicator !== false,
    evaluatorMode: EVALUATOR_MODES.has(config.evaluatorMode) ? config.evaluatorMode : "same-session",
    evaluatorModel: normalizeEvaluatorModel(config.evaluatorModel, hostCatalog),
    candidateModels: normalizeCandidateModels(config.candidateModels, hostCatalog),
    preferGpt: config.preferGpt !== false,
    externalModelThreshold: normalizeThreshold(config.externalModelThreshold),
    hostCatalog
  };
}

export function normalizeTaskOverride(patch) {
  if (patch === null) return null;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Task override must be an object or null.");
  }
  const allowed = ["showStatusIndicator", "evaluatorMode", "evaluatorModel", "candidateModels", "preferGpt", "externalModelThreshold"];
  const normalized = normalizeGlobalConfig({
    ...DEFAULT_GLOBAL_CONFIG,
    ...Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)))
  });
  return Object.fromEntries(allowed.map((key) => [key, normalized[key]]));
}

function normalizeTaskState(state, sessionId) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 9,
    sessionId: sanitizeSessionId(sessionId),
    enabled: Boolean(state.enabled),
    paused: Boolean(state.paused),
    override: state.override ? normalizeTaskOverride(state.override) : null,
    currentModel: cleanString(state.currentModel, 160),
    activeRequest: normalizeActiveRequest(state.activeRequest),
    routeTicket: normalizeRouteTicket(state.routeTicket),
    lastAssessment: normalizeAssessment(state.lastAssessment),
    assessmentHistory: normalizeAssessmentHistory(state.assessmentHistory),
    testHistory: normalizeAssessmentHistory(state.testHistory),
    observationHistory: normalizeObservationHistory(state.observationHistory),
    testObservationHistory: normalizeObservationHistory(state.testObservationHistory),
    createdAt: typeof state.createdAt === "string" ? state.createdAt : now,
    updatedAt: now
  };
}

function normalizeActiveRequest(request) {
  if (!request || typeof request !== "object") return null;
  return {
    turnId: cleanString(request.turnId, 200),
    promptHash: cleanHash(request.promptHash),
    originalModel: cleanString(request.originalModel, 160),
    commandAction: cleanCommandAction(request.commandAction),
    createdAt: typeof request.createdAt === "string" ? request.createdAt : new Date().toISOString()
  };
}

function normalizeRouteTicket(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  const expiresAt = typeof ticket.expiresAt === "string" ? ticket.expiresAt : null;
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) return null;
  return {
    gateId: cleanString(ticket.gateId, 80),
    assessmentId: cleanString(ticket.assessmentId, 80),
    turnId: cleanString(ticket.turnId, 200),
    promptHash: cleanHash(ticket.promptHash),
    originalModel: cleanString(ticket.originalModel, 160),
    recommendedModel: cleanString(ticket.recommendedModel, 160),
    status: GATE_STATUSES.has(ticket.status) ? ticket.status : "waiting",
    resumeNonce: cleanString(ticket.resumeNonce, 100),
    idempotencyKey: cleanString(ticket.idempotencyKey, 100),
    explicitDecision: EXPLICIT_DECISIONS.has(ticket.explicitDecision) ? ticket.explicitDecision : null,
    decisionAt: typeof ticket.decisionAt === "string" ? ticket.decisionAt : null,
    source: ticket.source === "test" ? "test" : "live",
    createdAt: typeof ticket.createdAt === "string" ? ticket.createdAt : new Date().toISOString(),
    expiresAt
  };
}

export function createRouteTicket(activeRequest, recommendedModel, now = Date.now(), assessmentId = null, source = "live") {
  if (!activeRequest?.promptHash || !recommendedModel) return null;
  return normalizeRouteTicket({
    ...activeRequest,
    gateId: randomUUID(),
    assessmentId,
    recommendedModel,
    source,
    status: "waiting",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TICKET_TTL_MS).toISOString()
  });
}

export function armRouteTicket(ticket, { gateId, decision, idempotencyKey }, now = Date.now()) {
  const normalized = normalizeRouteTicket(ticket);
  if (!normalized || normalized.gateId !== gateId) return null;
  if (Date.parse(normalized.expiresAt) <= now) return null;
  if (!EXPLICIT_DECISIONS.has(decision) || !cleanString(idempotencyKey, 100)) return null;
  if (normalized.status === "armed") {
    return normalized.idempotencyKey === idempotencyKey ? normalized : null;
  }
  return normalizeRouteTicket({
    ...normalized,
    status: "armed",
    resumeNonce: randomUUID(),
    idempotencyKey,
    explicitDecision: decision,
    decisionAt: new Date(now).toISOString()
  });
}

export function normalizeAssessment(assessment) {
  if (!assessment || typeof assessment !== "object") return null;
  const originalModel = cleanString(assessment.originalModel, 160);
  const recommendedModel = cleanString(assessment.recommendedModel, 160);
  const status = ASSESSMENT_STATUSES.has(assessment.status) ? assessment.status : "failed";
  return {
    assessmentId: cleanString(assessment.assessmentId, 80),
    turnId: cleanString(assessment.turnId, 200),
    promptHash: cleanHash(assessment.promptHash),
    originalModel,
    availableModels: normalizeModelList(assessment.availableModels),
    status,
    recommendedModel,
    changeDirection: status === "change" ? changeDirection(originalModel, recommendedModel) : null,
    rationale: cleanString(assessment.rationale, 600) || "未提供原因",
    evaluator: cleanString(assessment.evaluator, 80) || "unknown",
    evaluatorModel: cleanString(assessment.evaluatorModel, 160),
    evaluatorMode: EVALUATOR_MODES.has(assessment.evaluatorMode) ? assessment.evaluatorMode : "same-session",
    contextCoverage: ["same-session", "current-input-only"].includes(assessment.contextCoverage) ? assessment.contextCoverage : "same-session",
    requestedEvaluatorModel: cleanString(assessment.requestedEvaluatorModel, 160),
    fallback: normalizeFallback(assessment.fallback),
    startedAt: typeof assessment.startedAt === "string" ? assessment.startedAt : null,
    finishedAt: typeof assessment.finishedAt === "string" ? assessment.finishedAt : null,
    durationMs: normalizeDuration(assessment.durationMs),
    cost: normalizeCost(assessment.cost),
    source: assessment.source === "test" ? "test" : "live",
    confidence: ["low", "medium", "high"].includes(assessment.confidence) ? assessment.confidence : null,
    signals: normalizeStringList(assessment.signals, 6, 160),
    decisionBasis: normalizeStringList(assessment.decisionBasis, 4, 240),
    engineVersion: cleanString(assessment.engineVersion, 80) || "2.0.0",
    createdAt: typeof assessment.createdAt === "string"
      ? assessment.createdAt
      : new Date().toISOString()
  };
}

function normalizeAssessmentHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map(normalizeAssessment)
    .filter(Boolean)
    .slice(-HISTORY_LIMIT);
}

export function appendObservation(task, observation) {
  const result = OBSERVATION_RESULTS.has(observation.result) ? observation.result : "other";
  const entry = {
    result,
    assessmentId: cleanString(observation.assessmentId, 80),
    explicitDecision: EXPLICIT_DECISIONS.has(observation.explicitDecision) ? observation.explicitDecision : null,
    originalModel: cleanString(observation.originalModel, 160),
    recommendedModel: cleanString(observation.recommendedModel, 160),
    actualModel: cleanString(observation.actualModel, 160),
    source: observation.source === "test" ? "test" : "live",
    createdAt: new Date().toISOString()
  };
  const key = entry.source === "test" ? "testObservationHistory" : "observationHistory";
  task[key] = [...normalizeObservationHistory(task[key]), entry].slice(-HISTORY_LIMIT);
  return entry;
}

function normalizeObservationHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((entry) => entry && typeof entry === "object" && OBSERVATION_RESULTS.has(entry.result))
    .map((entry) => ({
      result: entry.result,
      assessmentId: cleanString(entry.assessmentId, 80),
      explicitDecision: EXPLICIT_DECISIONS.has(entry.explicitDecision) ? entry.explicitDecision : null,
      originalModel: cleanString(entry.originalModel, 160),
      recommendedModel: cleanString(entry.recommendedModel, 160),
      actualModel: cleanString(entry.actualModel, 160),
      source: entry.source === "test" ? "test" : "live",
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString()
    }))
    .slice(-HISTORY_LIMIT);
}

function normalizeModelList(models) {
  if (!Array.isArray(models)) return [];
  return [...new Set(models.map((model) => cleanString(model, 160)).filter(Boolean))].slice(0, 20);
}

function normalizeStringList(values, limit, maxLength) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => cleanString(value, maxLength)).filter(Boolean))].slice(0, limit);
}

function normalizeEvaluatorModel(value, hostCatalog) {
  const normalized = cleanString(value, 160);
  const defaults = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
  const available = [...defaults, ...(hostCatalog?.models?.map((model) => model.id) || [])];
  return available.find((model) => modelIdsEqual(model, normalized)) || "gpt-5.6-terra";
}

function normalizeCandidateModels(value, hostCatalog) {
  if (!Array.isArray(value)) return null;
  const allowed = [
    "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol",
    ...(hostCatalog?.models?.map((model) => model.id) || [])
  ];
  const selected = normalizeModelList(value)
    .map((model) => allowed.find((candidate) => modelIdsEqual(candidate, model)))
    .filter(Boolean);
  return selected.length ? [...new Set(selected)].slice(0, 50) : null;
}

function normalizeThreshold(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : 30;
}

function normalizeHostCatalog(value) {
  if (!value || typeof value !== "object") return null;
  const fetchedAt = typeof value.fetchedAt === "string" && !Number.isNaN(Date.parse(value.fetchedAt)) ? value.fetchedAt : null;
  if (!fetchedAt || !Array.isArray(value.models)) return null;
  const models = value.models
    .filter((model) => model && typeof model === "object")
    .map((model) => ({
      id: cleanString(model.id, 160),
      displayName: cleanString(model.displayName, 160),
      provider: model.provider === "gpt" ? "gpt" : "external",
      inputModalities: normalizeStringList(model.inputModalities, 3, 20),
      supportedReasoningEfforts: normalizeStringList(model.supportedReasoningEfforts, 8, 40)
    }))
    .filter((model) => model.id)
    .slice(0, 50);
  const rateLimit = value.rateLimit && typeof value.rateLimit === "object" ? {
    limitId: cleanString(value.rateLimit.limitId, 80),
    usedPercent: normalizePercent(value.rateLimit.usedPercent),
    remainingPercent: normalizePercent(value.rateLimit.remainingPercent),
    resetsAt: Number.isInteger(value.rateLimit.resetsAt) ? value.rateLimit.resetsAt : null,
    windowDurationMins: Number.isInteger(value.rateLimit.windowDurationMins) ? value.rateLimit.windowDurationMins : null,
    planType: cleanString(value.rateLimit.planType, 80)
  } : null;
  return { source: cleanString(value.source, 80) || "unknown", fetchedAt, models, rateLimit };
}

function normalizePercent(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
}

function normalizeFallback(value) {
  if (!value || typeof value !== "object") return null;
  return {
    from: cleanString(value.from, 80),
    to: cleanString(value.to, 80),
    reason: cleanString(value.reason, 600),
    at: typeof value.at === "string" ? value.at : null
  };
}

function normalizeDuration(value) {
  return Number.isFinite(value) && value >= 0 && value <= 300_000 ? Math.round(value) : null;
}

function normalizeCost(value) {
  if (!value || typeof value !== "object") return null;
  const estimatedUsd = Number.isFinite(value.estimatedUsd) && value.estimatedUsd >= 0 ? Number(value.estimatedUsd.toFixed(6)) : null;
  return {
    kind: cleanString(value.kind, 80) || "unavailable",
    currency: cleanString(value.currency, 12) || "USD",
    estimatedUsd,
    inputTokensEstimate: Number.isFinite(value.inputTokensEstimate) ? Math.max(0, Math.round(value.inputTokensEstimate)) : null,
    outputTokensEstimate: Number.isFinite(value.outputTokensEstimate) ? Math.max(0, Math.round(value.outputTokensEstimate)) : null,
    note: cleanString(value.note, 600)
  };
}

function cleanString(value, maxLength) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function cleanHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function cleanCommandAction(value) {
  return ["check", "check-inline", "test-card", "test"].includes(value) ? value : null;
}
