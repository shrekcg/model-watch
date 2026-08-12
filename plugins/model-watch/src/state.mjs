import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

export const DEFAULT_GLOBAL_CONFIG = Object.freeze({
  schemaVersion: 1,
  autoEnableNewTasks: false,
  reminderTiming: "on-change",
  modelSelection: "main",
  independentModel: null,
  independentEffort: "medium"
});

const REMINDER_TIMINGS = new Set(["on-change", "every-turn", "manual"]);
const MODEL_SELECTIONS = new Set(["main", "independent", "hybrid"]);
const EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);

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

  const marketplace = parts[cacheIndex + 1];
  const plugin = parts[cacheIndex + 2];
  return join(root, ...parts.slice(0, cacheIndex), "data", `${marketplace}-${plugin}`);
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
    const candidates = readdirSync(tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const path = join(tasksDir, entry.name);
        return { sessionId: entry.name.slice(0, -5), modifiedAt: statSync(path).mtimeMs };
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    return candidates[0]?.sessionId || null;
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

export function loadGlobalConfig(dataDir = resolveDataDir()) {
  const stored = readJson(globalPath(dataDir), {});
  return normalizeGlobalConfig({ ...DEFAULT_GLOBAL_CONFIG, ...stored });
}

export function saveGlobalConfig(config, dataDir = resolveDataDir()) {
  const normalized = normalizeGlobalConfig(config);
  writeJsonAtomic(globalPath(dataDir), normalized);
  return normalized;
}

export function updateGlobalConfig(patch, dataDir = resolveDataDir()) {
  return saveGlobalConfig({ ...loadGlobalConfig(dataDir), ...patch }, dataDir);
}

export function loadTaskState(sessionId, dataDir = resolveDataDir()) {
  const globalConfig = loadGlobalConfig(dataDir);
  const fallback = createTaskState(sessionId, globalConfig.autoEnableNewTasks);
  const stored = readJson(taskPath(dataDir, sessionId), fallback);
  return normalizeTaskState({ ...fallback, ...stored }, sessionId);
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
  writeJsonAtomic(taskPath(dataDir, sessionId), normalized);
  return normalized;
}

export function updateTaskState(sessionId, patch, dataDir = resolveDataDir()) {
  return saveTaskState(sessionId, { ...loadTaskState(sessionId, dataDir), ...patch }, dataDir);
}

export function getEffectiveConfig(sessionId, dataDir = resolveDataDir()) {
  const globalConfig = loadGlobalConfig(dataDir);
  const task = loadTaskState(sessionId, dataDir);
  const override = task.override || {};
  return normalizeGlobalConfig({ ...globalConfig, ...override });
}

export function createTaskState(sessionId, enabled = false) {
  return {
    schemaVersion: 1,
    sessionId: sanitizeSessionId(sessionId),
    enabled: Boolean(enabled),
    override: null,
    currentModel: null,
    currentEffort: null,
    effortSource: null,
    effortPrompted: false,
    lastAssessment: null,
    pendingGate: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function normalizeGlobalConfig(config) {
  const normalized = {
    schemaVersion: 1,
    autoEnableNewTasks: Boolean(config.autoEnableNewTasks),
    reminderTiming: REMINDER_TIMINGS.has(config.reminderTiming)
      ? config.reminderTiming
      : DEFAULT_GLOBAL_CONFIG.reminderTiming,
    modelSelection: MODEL_SELECTIONS.has(config.modelSelection)
      ? config.modelSelection
      : DEFAULT_GLOBAL_CONFIG.modelSelection,
    independentModel:
      typeof config.independentModel === "string" && config.independentModel.trim()
        ? config.independentModel.trim()
        : null,
    independentEffort: EFFORTS.has(config.independentEffort)
      ? config.independentEffort
      : DEFAULT_GLOBAL_CONFIG.independentEffort
  };
  return normalized;
}

export function normalizeTaskOverride(patch) {
  if (patch === null) return null;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Task override must be an object or null.");
  }
  const result = {};
  if ("reminderTiming" in patch) {
    if (!REMINDER_TIMINGS.has(patch.reminderTiming)) throw new RangeError("Invalid reminderTiming.");
    result.reminderTiming = patch.reminderTiming;
  }
  if ("modelSelection" in patch) {
    if (!MODEL_SELECTIONS.has(patch.modelSelection)) throw new RangeError("Invalid modelSelection.");
    result.modelSelection = patch.modelSelection;
  }
  if ("independentModel" in patch) {
    result.independentModel =
      typeof patch.independentModel === "string" && patch.independentModel.trim()
        ? patch.independentModel.trim()
        : null;
  }
  if ("independentEffort" in patch) {
    if (!EFFORTS.has(patch.independentEffort)) throw new RangeError("Invalid independentEffort.");
    result.independentEffort = patch.independentEffort;
  }
  return result;
}

function normalizeTaskState(state, sessionId) {
  const now = new Date().toISOString();
  const pendingGateCreatedAt = Date.parse(state.pendingGate?.createdAt || "");
  const pendingGateFresh =
    Number.isFinite(pendingGateCreatedAt) && Date.now() - pendingGateCreatedAt < 24 * 60 * 60 * 1000;
  return {
    schemaVersion: 1,
    sessionId: sanitizeSessionId(sessionId),
    enabled: Boolean(state.enabled),
    override: state.override ? normalizeTaskOverride(state.override) : null,
    currentModel: typeof state.currentModel === "string" && state.currentModel ? state.currentModel : null,
    currentEffort: EFFORTS.has(state.currentEffort) ? state.currentEffort : null,
    effortSource: ["user", "default", "detected"].includes(state.effortSource)
      ? state.effortSource
      : null,
    effortPrompted: Boolean(state.effortPrompted),
    lastAssessment: state.lastAssessment && typeof state.lastAssessment === "object"
      ? state.lastAssessment
      : null,
    pendingGate:
      pendingGateFresh && state.pendingGate && typeof state.pendingGate === "object"
        ? state.pendingGate
        : null,
    createdAt: typeof state.createdAt === "string" ? state.createdAt : now,
    updatedAt: now
  };
}

export function validateEffort(effort) {
  if (!EFFORTS.has(effort)) throw new RangeError(`Unsupported reasoning effort: ${effort}`);
  return effort;
}
