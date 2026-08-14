const API_PRICES_PER_MILLION = Object.freeze({
  "gpt-5.6-luna": { input: 1, output: 6 },
  "gpt-5.6-terra": { input: 2.5, output: 15 },
  "gpt-5.6-sol": { input: 5, output: 30 }
});

const DEFAULT_OUTPUT_TOKENS = 350;

export function estimateFixedEvaluatorCost({ model, prompt }) {
  const price = API_PRICES_PER_MILLION[model];
  if (!price) return unavailableCost("当前模型没有可用的公开 API 价格表");
  const inputTokensEstimate = Math.max(1, Math.ceil(Buffer.byteLength(String(prompt || ""), "utf8") / 3));
  const outputTokensEstimate = DEFAULT_OUTPUT_TOKENS;
  const estimatedUsd = (inputTokensEstimate * price.input + outputTokensEstimate * price.output) / 1_000_000;
  return {
    kind: "api-equivalent-estimate",
    currency: "USD",
    estimatedUsd: Number(estimatedUsd.toFixed(6)),
    inputTokensEstimate,
    outputTokensEstimate,
    note: "按可见评估包与 350 输出 token 的 API 标价粗估；不含隐藏推理、缓存、工具或订阅额度。"
  };
}

export function unavailableCost(reason) {
  return { kind: "unavailable", currency: "USD", estimatedUsd: null, note: reason };
}

export function sameSessionCost() {
  return unavailableCost("同会话判断与主任务共用一次 Codex 任务，无法把费用或订阅额度可靠归因到评估本身。");
}

export function formatCost(cost) {
  if (!cost || cost.estimatedUsd === null || cost.estimatedUsd === undefined) return "—";
  return `$${Number(cost.estimatedUsd).toFixed(4)}`;
}
