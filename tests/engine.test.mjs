import assert from "node:assert/strict";
import test from "node:test";
import { hashPrompt, normalizeEngineResult } from "../plugins/model-watch/src/engine.mjs";

test("engine validates candidate models and hashes identical requests consistently", () => {
  const result = normalizeEngineResult({
    status: "change",
    recommendedModel: "gpt-5.6-sol",
    rationale: "本轮风险显著提高",
    evaluator: "same-session"
  }, ["gpt-5.6-sol"], "gpt-5.6-terra");
  assert.equal(result.status, "change");
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

test("engine compares model identifiers case-insensitively", () => {
  const result = normalizeEngineResult({
    status: "change",
    recommendedModel: "GPT-5.6-LUNA",
    rationale: "模型名大小写不应形成切换"
  }, ["gpt-5.6-luna", "gpt-5.6-sol"], "gpt-5.6-luna");
  assert.equal(result.status, "failed");
});
