import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

export const DEFAULT_GLOBAL_CONFIG = Object.freeze({
  schemaVersion: 3,
  autoEnableNewTasks: false,
  showStatusIndicator: true
});

const ASSESSMENT_STATUSES = new Set(["stay", "change", "uncertain", "failed"]);
const OBSERVATION_RESULTS = new Set(["adopted", "kept", "other", "superseded"]);
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

export function resolveLatestTaskSession(dataDir = resolveDataDir()) {
  try {
    const tasksDir = join(dataDir, "tasks");
    return readdirSync(tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const path = join(tasksDir, entry.name);
        return { sessionId: entry.name.slice(0, -5), modifiedAt: statSync(path).mtimeMs };
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.sessionId || null;
  } catch {
    return null;
  }
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
    schemaVersion: 3,
    sessionId: sanitizeSessionId(sessionId),
    enabled: Boolean(enabled),
    paused: false,
    override: null,
    currentModel: null,
    activeRequest: null,
    routeTicket: null,
    lastAssessment: null,
    observationHistory: [],
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
  return {
    schemaVersion: 3,
    autoEnableNewTasks: Boolean(config.autoEnableNewTasks),
    showStatusIndicator: config.showStatusIndicator !== false
  };
}

export function normalizeTaskOverride(patch) {
  if (patch === null) return null;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Task override must be an object or null.");
  }
  const allowed = ["showStatusIndicator"];
  const normalized = normalizeGlobalConfig({
    ...DEFAULT_GLOBAL_CONFIG,
    ...Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)))
  });
  return Object.fromEntries(allowed.map((key) => [key, normalized[key]]));
}

function normalizeTaskState(state, sessionId) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    sessionId: sanitizeSessionId(sessionId),
    enabled: Boolean(state.enabled),
    paused: Boolean(state.paused),
    override: state.override ? normalizeTaskOverride(state.override) : null,
    currentModel: cleanString(state.currentModel, 160),
    activeRequest: normalizeActiveRequest(state.activeRequest),
    routeTicket: normalizeRouteTicket(state.routeTicket),
    lastAssessment: normalizeAssessment(state.lastAssessment),
    observationHistory: normalizeObservationHistory(state.observationHistory),
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
    createdAt: typeof request.createdAt === "string" ? request.createdAt : new Date().toISOString()
  };
}

function normalizeRouteTicket(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  const expiresAt = typeof ticket.expiresAt === "string" ? ticket.expiresAt : null;
  if (!expiresAt || Date.parse(expiresAt) <= Date.now()) return null;
  return {
    turnId: cleanString(ticket.turnId, 200),
    promptHash: cleanHash(ticket.promptHash),
    originalModel: cleanString(ticket.originalModel, 160),
    recommendedModel: cleanString(ticket.recommendedModel, 160),
    createdAt: typeof ticket.createdAt === "string" ? ticket.createdAt : new Date().toISOString(),
    expiresAt
  };
}

export function createRouteTicket(activeRequest, recommendedModel, now = Date.now()) {
  if (!activeRequest?.promptHash || !recommendedModel) return null;
  return normalizeRouteTicket({
    ...activeRequest,
    recommendedModel,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TICKET_TTL_MS).toISOString()
  });
}

export function normalizeAssessment(assessment) {
  if (!assessment || typeof assessment !== "object") return null;
  return {
    status: ASSESSMENT_STATUSES.has(assessment.status) ? assessment.status : "failed",
    recommendedModel: cleanString(assessment.recommendedModel, 160),
    rationale: cleanString(assessment.rationale, 600) || "未提供原因",
    evaluator: cleanString(assessment.evaluator, 80) || "unknown",
    engineVersion: cleanString(assessment.engineVersion, 80) || "2.0.0",
    createdAt: typeof assessment.createdAt === "string"
      ? assessment.createdAt
      : new Date().toISOString()
  };
}

export function appendObservation(task, observation) {
  const result = OBSERVATION_RESULTS.has(observation.result) ? observation.result : "other";
  const entry = {
    result,
    originalModel: cleanString(observation.originalModel, 160),
    recommendedModel: cleanString(observation.recommendedModel, 160),
    actualModel: cleanString(observation.actualModel, 160),
    createdAt: new Date().toISOString()
  };
  task.observationHistory = [...normalizeObservationHistory(task.observationHistory), entry].slice(-12);
  return entry;
}

function normalizeObservationHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((entry) => entry && typeof entry === "object" && OBSERVATION_RESULTS.has(entry.result))
    .map((entry) => ({
      result: entry.result,
      originalModel: cleanString(entry.originalModel, 160),
      recommendedModel: cleanString(entry.recommendedModel, 160),
      actualModel: cleanString(entry.actualModel, 160),
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString()
    }))
    .slice(-12);
}

function cleanString(value, maxLength) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function cleanHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}
