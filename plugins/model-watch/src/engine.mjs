import { createHash } from "node:crypto";

export const ENGINE_VERSION = "2.0.0";

export function hashPrompt(prompt) {
  return createHash("sha256").update(String(prompt || ""), "utf8").digest("hex");
}

export function normalizeEngineResult(value, availableModels = [], currentModel = null) {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  const statuses = new Set(["stay", "change", "uncertain", "failed"]);
  if (!parsed || typeof parsed !== "object" || !statuses.has(parsed.status)) {
    return failedResult("评估器返回格式无效");
  }
  const recommendedModel = typeof parsed.recommendedModel === "string"
    ? parsed.recommendedModel.trim()
    : null;
  if (parsed.status === "change") {
    if (!recommendedModel || (availableModels.length && !availableModels.includes(recommendedModel))) {
      return failedResult("评估器返回了不可用模型");
    }
    if (!currentModel) return failedResult("当前模型身份未知，不能形成有效切换建议");
    if (recommendedModel === currentModel) return failedResult("推荐模型与当前模型相同，无法形成有效切换建议");
  }
  return {
    status: parsed.status,
    recommendedModel: parsed.status === "change" ? recommendedModel : null,
    rationale: typeof parsed.rationale === "string" && parsed.rationale.trim()
      ? parsed.rationale.trim().slice(0, 600)
      : "当前信息不足以形成可靠的切换建议",
    evaluator: typeof parsed.evaluator === "string" ? parsed.evaluator.slice(0, 80) : "unknown",
    engineVersion: ENGINE_VERSION,
    createdAt: new Date().toISOString()
  };
}

export function failedResult(rationale, evaluator = "failed") {
  return {
    status: "failed",
    recommendedModel: null,
    rationale,
    evaluator,
    engineVersion: ENGINE_VERSION,
    createdAt: new Date().toISOString()
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/u);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}
