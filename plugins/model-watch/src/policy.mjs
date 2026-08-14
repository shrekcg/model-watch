import { modelProfilesFor } from "./models.mjs";

export const POLICY_VERSION = "3.0.0";

export function buildRecommendationPolicy(availableModels) {
  const profiles = modelProfilesFor(availableModels)
    .map(({ model, profile }) => `${model}：${profile.role}；适合${profile.suitableFor}`)
    .join("\n");
  return [
    `[MODEL_WATCH_POLICY ${POLICY_VERSION}]`,
    "推荐目标是选择能以合理成本稳定完成本轮剩余工作的最低充分模型，而不是证明当前模型是否‘也可能完成’。",
    "先判断本轮的后果、工作范围、推演链路、验证强度、可逆性、上下文/工具协调与返工风险；再比较当前模型与每个候选模型的能力/模态匹配、可用性、速度、成本和切换损耗。项目上下文存在时优先使用项目约束；普通对话、学习、写作和排查也使用同一框架。",
    "候选可以比当前模型更强、相近或更轻量。不要预设只能升级：当更强候选能实质降低遗漏、错误、返工或不安全结论风险时可以 change；当更轻量候选已足够、且速度或成本收益大于切换损耗时也可以 change；收益不明确则 stay 或 uncertain。",
    "不要按任务名称做固定路由，不使用固定分数或硬阈值；模型画像只用于帮助比较，最终仍由当前证据和模型原生判断决定。候选的模态、工具或可用性信息不足时，不能把它当成确定推荐依据。",
    "模型画像：",
    profiles || "候选模型画像不可用。",
    "输出判断时提供 confidence（low/medium/high）、signals（不超过 6 条事实信号）和 decisionBasis（不超过 4 条具体依据）。"
  ].join("\n");
}
