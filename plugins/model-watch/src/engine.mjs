import { createHash } from "node:crypto";
import { modelIdsEqual, normalizeModelId } from "./models.mjs";

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
    const matchedCandidate = availableModels.find((candidate) => modelIdsEqual(candidate, recommendedModel));
    if (!recommendedModel || (availableModels.length && !matchedCandidate)) {
      return failedResult("评估器返回了不可用模型");
    }
    if (!currentModel) return failedResult("当前模型身份未知，不能形成有效切换建议");
    if (modelIdsEqual(matchedCandidate || recommendedModel, currentModel)) {
      return failedResult("推荐模型与当前模型相同，无法形成有效切换建议");
    }
    return {
      status: parsed.status,
      recommendedModel: matchedCandidate || recommendedModel,
      rationale: typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim().slice(0, 600)
        : "当前信息不足以形成可靠的切换建议",
      evaluator: typeof parsed.evaluator === "string" ? parsed.evaluator.slice(0, 80) : "unknown",
      confidence: normalizeConfidence(parsed.confidence),
      signals: normalizeEvidence(parsed.signals, 6, 160),
      decisionBasis: normalizeEvidence(parsed.decisionBasis, 4, 240),
      engineVersion: ENGINE_VERSION,
      createdAt: new Date().toISOString()
    };
  }
  return {
    status: parsed.status,
    recommendedModel: parsed.status === "change" ? recommendedModel : null,
    rationale: typeof parsed.rationale === "string" && parsed.rationale.trim()
      ? parsed.rationale.trim().slice(0, 600)
      : "当前信息不足以形成可靠的切换建议",
    evaluator: typeof parsed.evaluator === "string" ? parsed.evaluator.slice(0, 80) : "unknown",
    confidence: normalizeConfidence(parsed.confidence),
    signals: normalizeEvidence(parsed.signals, 6, 160),
    decisionBasis: normalizeEvidence(parsed.decisionBasis, 4, 240),
    engineVersion: ENGINE_VERSION,
    createdAt: new Date().toISOString()
  };
}

function normalizeConfidence(value) {
  return ["low", "medium", "high"].includes(value) ? value : null;
}

function normalizeEvidence(values, limit, maxLength) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().slice(0, maxLength))
  )].slice(0, limit);
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
