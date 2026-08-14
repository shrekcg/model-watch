export const DEFAULT_MODELS = Object.freeze([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol"
]);

export const MODEL_PROFILES = Object.freeze({
  "gpt-5.6-luna": Object.freeze({
    label: "GPT-5.6 Luna",
    role: "高效率、高吞吐",
    suitableFor: "范围明确、可逆、验证简单、失败返工成本低的工作"
  }),
  "gpt-5.6-terra": Object.freeze({
    label: "GPT-5.6 Terra",
    role: "质量、速度与成本平衡",
    suitableFor: "中等复杂度、多步骤或需要一定工具协调的工作"
  }),
  "gpt-5.6-sol": Object.freeze({
    label: "GPT-5.6 Sol",
    role: "旗舰能力",
    suitableFor: "高风险生产决策、跨系统一致性、长链路证据整合和多约束推演"
  })
});

const GPT_RELATIVE_CAPABILITY = Object.freeze({
  "gpt-5.6-luna": 1,
  "gpt-5.6-terra": 2,
  "gpt-5.6-sol": 3
});

export function availableModelsFromEnv(env = process.env) {
  const configured = String(env.MODEL_WATCH_AVAILABLE_MODELS || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return configured.length ? [...new Set(configured)] : [...DEFAULT_MODELS];
}

export function candidateCatalog(config = {}, env = process.env, now = Date.now()) {
  const configured = String(env.MODEL_WATCH_AVAILABLE_MODELS || "")
    .split(",").map((model) => model.trim()).filter(Boolean);
  const snapshot = config.hostCatalog;
  const fetchedAt = snapshot?.fetchedAt ? Date.parse(snapshot.fetchedAt) : Number.NaN;
  const fresh = Number.isFinite(fetchedAt) && now - fetchedAt <= 60 * 60 * 1000;
  const discovered = configured.length
    ? configured.map((id) => ({ id, provider: isGptModel(id) ? "gpt" : "external", inputModalities: [] }))
    : fresh && Array.isArray(snapshot.models)
      ? snapshot.models
      : DEFAULT_MODELS.map((id) => ({ id, provider: "gpt", inputModalities: ["text", "image"] }));
  const selectedIds = Array.isArray(config.candidateModels) && config.candidateModels.length
    ? new Set(config.candidateModels.map(normalizeModelId).filter(Boolean))
    : null;
  const models = selectedIds
    ? discovered.filter((model) => selectedIds.has(normalizeModelId(model.id)))
    : discovered;
  const gpt = models.filter((model) => model.provider === "gpt");
  const external = models.filter((model) => model.provider !== "gpt");
  const externalOnly = config.preferGpt && (
    snapshot?.rateLimit?.limitId === "codex" &&
    Number.isFinite(snapshot.rateLimit.remainingPercent) &&
    snapshot.rateLimit.remainingPercent <= config.externalModelThreshold
  );
  if (!config.preferGpt) return models;
  if (externalOnly) return external.length ? external : gpt;
  return gpt.length ? gpt : external;
}

export function availableModelsForConfig(config = {}, env = process.env) {
  return candidateCatalog(config, env).map((model) => model.id);
}

export function isGptModel(model) {
  return normalizeModelId(model)?.startsWith("gpt-") || false;
}

export function formatCandidateDirectory(config = {}, env = process.env) {
  return candidateCatalog(config, env)
    .map((model) => `${model.id}（提供方：${model.provider === "gpt" ? "GPT 原生" : "外部"}；输入：${model.inputModalities?.join("/") || "未知"}）`)
    .join("\n");
}

export function normalizeModelId(model) {
  return typeof model === "string" && model.trim()
    ? model.trim().toLowerCase()
    : null;
}

export function modelIdsEqual(left, right) {
  const normalizedLeft = normalizeModelId(left);
  return Boolean(normalizedLeft && normalizedLeft === normalizeModelId(right));
}

export function modelProfile(model) {
  return MODEL_PROFILES[normalizeModelId(model)] || null;
}

export function modelProfilesFor(models = []) {
  return models
    .map((model) => ({ model, profile: modelProfile(model) }))
    .filter(({ profile }) => Boolean(profile));
}

// Reporting-only metadata. The evaluator itself still compares every candidate
// against the active task; this must never choose a model on its own.
export function changeDirection(currentModel, recommendedModel) {
  const current = GPT_RELATIVE_CAPABILITY[normalizeModelId(currentModel)];
  const recommended = GPT_RELATIVE_CAPABILITY[normalizeModelId(recommendedModel)];
  if (!current || !recommended) return "unknown";
  if (recommended > current) return "up";
  if (recommended < current) return "down";
  return "lateral";
}
