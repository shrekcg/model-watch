export const DEFAULT_MODELS = Object.freeze([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol"
]);

export function availableModelsFromEnv(env = process.env) {
  const configured = String(env.MODEL_WATCH_AVAILABLE_MODELS || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return configured.length ? [...new Set(configured)] : [...DEFAULT_MODELS];
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
