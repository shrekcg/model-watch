import assert from "node:assert/strict";
import test from "node:test";
import { hashPrompt, normalizeEngineResult } from "../plugins/model-watch/src/engine.mjs";
import { runFixedEvaluator } from "../plugins/model-watch/src/fixed-evaluator.mjs";
import { availableModelsForConfig, candidateCatalog, changeDirection } from "../plugins/model-watch/src/models.mjs";
import { refreshHostCatalog } from "../plugins/model-watch/src/host-catalog.mjs";

test("engine validates candidate models and hashes identical requests consistently", () => {
  const result = normalizeEngineResult({
    status: "change",
    recommendedModel: "gpt-5.6-sol",
    rationale: "本轮风险显著提高",
    evaluator: "same-session"
  }, ["gpt-5.6-sol"], "gpt-5.6-terra");
  assert.equal(result.status, "change");
  assert.equal(result.confidence, null);
  assert.equal(hashPrompt("同一请求"), hashPrompt("同一请求"));

  const sameModel = normalizeEngineResult({
    status: "change",
    recommendedModel: "gpt-5.6-sol",
    rationale: "错误的同模型建议"
  }, ["gpt-5.6-sol"], "gpt-5.6-sol");
  assert.equal(sameModel.status, "failed");

  const unknownCurrent = normalizeEngineResult({
    status: "change",
    recommendedModel: "gpt-5.6-sol",
    rationale: "当前模型未知"
  }, ["gpt-5.6-sol"]);
  assert.equal(unknownCurrent.status, "failed");
});

test("engine retains bounded structured decision evidence", () => {
  const result = normalizeEngineResult({
    status: "change",
    recommendedModel: "gpt-5.6-sol",
    rationale: "跨系统生产审计",
    confidence: "high",
    signals: ["生产支付决策", "跨服务一致性"],
    decisionBasis: ["错误结论会造成资金损失"]
  }, ["gpt-5.6-luna", "gpt-5.6-sol"], "gpt-5.6-luna");
  assert.equal(result.confidence, "high");
  assert.deepEqual(result.signals, ["生产支付决策", "跨服务一致性"]);
  assert.deepEqual(result.decisionBasis, ["错误结论会造成资金损失"]);
});

test("engine compares model identifiers case-insensitively", () => {
  const result = normalizeEngineResult({
    status: "change",
    recommendedModel: "GPT-5.6-LUNA",
    rationale: "模型名大小写不应形成切换"
  }, ["gpt-5.6-luna", "gpt-5.6-sol"], "gpt-5.6-luna");
  assert.equal(result.status, "failed");
});

test("change direction reports both GPT upgrade and downgrade without deciding the recommendation", () => {
  assert.equal(changeDirection("gpt-5.6-luna", "gpt-5.6-sol"), "up");
  assert.equal(changeDirection("gpt-5.6-sol", "gpt-5.6-terra"), "down");
  assert.equal(changeDirection("deepseek-v4", "gpt-5.6-terra"), "unknown");
});

test("host catalog keeps GPT candidates first until the configurable limit threshold is reached", () => {
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    models: [
      { id: "gpt-5.6-luna", provider: "gpt", inputModalities: ["text", "image"] },
      { id: "gpt-5.6-terra", provider: "gpt", inputModalities: ["text", "image"] },
      { id: "opencode-go/deepseek-v4-pro", provider: "external", inputModalities: ["text", "image"] }
    ],
    rateLimit: { limitId: "codex", remainingPercent: 45 }
  };
  assert.deepEqual(availableModelsForConfig({ preferGpt: true, externalModelThreshold: 30, hostCatalog: snapshot }), [
    "gpt-5.6-luna", "gpt-5.6-terra"
  ]);
  assert.deepEqual(availableModelsForConfig({ preferGpt: true, externalModelThreshold: 50, hostCatalog: snapshot }), ["opencode-go/deepseek-v4-pro"]);
  assert.deepEqual(availableModelsForConfig({ preferGpt: false, externalModelThreshold: 30, hostCatalog: snapshot }), [
    "gpt-5.6-luna", "gpt-5.6-terra", "opencode-go/deepseek-v4-pro"
  ]);
});

test("selected candidate models are partitioned into GPT and third-party pools", () => {
  const snapshot = {
    fetchedAt: new Date().toISOString(),
    models: [
      { id: "gpt-5.6-luna", provider: "gpt" },
      { id: "gpt-5.6-terra", provider: "gpt" },
      { id: "gpt-5.6-sol", provider: "gpt" },
      { id: "opencode-go/deepseek-v4-pro", provider: "external" },
      { id: "opencode-go/kimi-k3", provider: "external" }
    ],
    rateLimit: { limitId: "codex", remainingPercent: 40 }
  };
  const config = { hostCatalog: snapshot, candidateModels: ["gpt-5.6-luna", "gpt-5.6-terra", "opencode-go/deepseek-v4-pro", "opencode-go/kimi-k3"], preferGpt: true, externalModelThreshold: 30 };
  assert.deepEqual(availableModelsForConfig(config), ["gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.deepEqual(availableModelsForConfig({ ...config, externalModelThreshold: 40 }), ["opencode-go/deepseek-v4-pro", "opencode-go/kimi-k3"]);
});

test("expired host catalog safely falls back to built-in GPT candidates", () => {
  const stale = {
    fetchedAt: new Date(Date.now() - 61 * 60 * 1000).toISOString(),
    models: [{ id: "opencode-go/deepseek-v4-pro", provider: "external", inputModalities: ["text"] }],
    rateLimit: { limitId: "codex", remainingPercent: 5 }
  };
  assert.deepEqual(candidateCatalog({ preferGpt: true, externalModelThreshold: 30, hostCatalog: stale }).map((model) => model.id), [
    "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"
  ]);
});

test("host catalog fixture is sanitized and never needs a live desktop process", async () => {
  const snapshot = await refreshHostCatalog({
    env: {
      MODEL_WATCH_HOST_CATALOG_JSON: JSON.stringify({
        models: [
          { id: "gpt-5.6-terra", displayName: "GPT Terra", inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
          { id: "opencode-go/deepseek-v4-pro", displayName: "DeepSeek", inputModalities: ["text"] },
          { id: "hidden", hidden: true }
        ],
        rateLimits: { limitId: "codex", primary: { usedPercent: 72, windowDurationMins: 10080 } }
      })
    }
  });
  assert.equal(snapshot.models.length, 2);
  assert.equal(snapshot.models[0].provider, "gpt");
  assert.equal(snapshot.rateLimit.remainingPercent, 28);
  assert.equal(snapshot.rateLimit.limitId, "codex");
});

test("host catalog app-server client follows the required initialized handshake", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../plugins/model-watch/src/host-catalog.mjs", import.meta.url), "utf8"));
  assert.match(source, /protocolVersion: "2025-06-18"/);
  assert.match(source, /notifications\/initialized/);
  assert.match(source, /读取宿主目录超时/);
});

test("fixed evaluator mock preserves its configured evaluator model", async () => {
  const result = await runFixedEvaluator({
    prompt: "生产支付系统审计",
    currentModel: "gpt-5.6-luna",
    availableModels: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
    evaluatorModel: "gpt-5.6-terra",
    env: {
      MODEL_WATCH_FIXED_EVALUATOR_RESULT: JSON.stringify({
        status: "change",
        recommendedModel: "gpt-5.6-sol",
        rationale: "跨服务生产审计",
        confidence: "high",
        signals: ["资金风险"]
      })
    }
  });
  assert.equal(result.status, "change");
  assert.equal(result.evaluatorMode, "fixed-codex");
  assert.equal(result.evaluatorModel, "gpt-5.6-terra");
  assert.equal(result.contextCoverage, "current-input-only");
  assert.equal(result.cost.kind, "api-equivalent-estimate");
  assert.ok(result.cost.estimatedUsd > 0);
  assert.ok(result.durationMs >= 0);
});

test("fixed evaluator failure exposes timing but never invents a cost", async () => {
  const result = await runFixedEvaluator({
    prompt: "",
    currentModel: "gpt-5.6-luna",
    availableModels: ["gpt-5.6-luna", "gpt-5.6-terra"],
    evaluatorModel: "gpt-5.6-terra"
  });
  assert.equal(result.status, "failed");
  assert.equal(result.cost.estimatedUsd, null);
  assert.ok(result.durationMs >= 0);
});
