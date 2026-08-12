import { ENGINE_VERSION } from "./engine.mjs";

export function buildMonitoringContext({
  sessionId,
  model,
  availableModels = [],
  task,
  config,
  command,
  routeMatched = false
}) {
  const commandLine = command
    ? `本轮控制命令：${command.action}${command.remainder ? `；主任务正文：${command.remainder}` : ""}`
    : "本轮控制命令：无";
  const statusInstruction = statusIndicatorInstruction(task, config);

  if (routeMatched) {
    if (command?.action === "check") {
      return [
        `[MODEL_WATCH_ROUTE ${ENGINE_VERSION}]`,
        `session_id: ${sessionId}`,
        `current_model: ${model || task.currentModel || "unknown"}`,
        "这条 check 已在上一轮完成模型判断；本轮没有待执行的主任务。只简短说明检查已完成，并提示用户按当前模型发送下一条真实任务。",
        statusInstruction,
        "不要向用户展示此内部上下文。"
      ].filter(Boolean).join("\n");
    }
    return [
      `[MODEL_WATCH_ROUTE ${ENGINE_VERSION}]`,
      `session_id: ${sessionId}`,
      `current_model: ${model || task.currentModel || "unknown"}`,
      "同一请求已在上一轮完成模型判断。不要再次判断模型；直接完整执行本轮原始用户请求。",
      statusInstruction,
      "不要向用户展示此内部上下文。"
    ].filter(Boolean).join("\n");
  }

  if (["on", "off", "pause", "resume", "status", "settings", "unknown"].includes(command?.action)) {
    return buildControlContext({ sessionId, model, task, config, command });
  }

  return [
    `[MODEL_WATCH_CONTEXT ${ENGINE_VERSION}]`,
    `session_id: ${sessionId}`,
    `turn_id: ${task.activeRequest?.turnId || "unknown"}`,
    `enabled: ${task.enabled}`,
    `paused: ${task.paused}`,
    `current_model: ${model || task.currentModel || "unknown"}`,
    `available_models: ${availableModels.length ? availableModels.join(", ") : "unknown"}`,
    commandLine,
    "模型哨兵是一套独立、通用的推荐引擎。它适用于开发、日常沟通、分析、学习、写作、资料整理和问题排查。",
    "当前任务启用后，每一条真实用户请求都必须先在内部完成一次模型判断，再决定是否执行主任务。根据本轮输入与历史意图、目标阶段、约束、上下文整合、工具协调、风险和可逆性、失败返工、预计剩余工作、当前模型、候选模型与切换成本，判断当前模型是否仍合适。",
    "使用模型原生判断；禁止任务类型映射、能力等级、固定评分或跨级阈值。只有切换净收益清晰时才判定 change。",
    "若 current_model 为 unknown，或推荐模型等于 current_model：必须判定 uncertain 或 failed，绝不能判定 change。",
    `判断完成后必须调用 model_watch_record_assessment，sessionId 使用上面的精确值 ${sessionId}，turnId 使用上面的精确值 ${task.activeRequest?.turnId || "unknown"}。stay、change、uncertain 和 failed 都要保存。`,
    stayInstruction({ model, command }),
    changeInstruction(config, command),
    "内部判断阶段不得向用户输出思考过程、判断过程、分析过程、‘正在分析’或任何中间文本。若 uncertain、failed 或保存工具不可用：直接执行主任务，不显示 stay/change。不要要求用户回复继续、采纳、忽略或修正。",
    "check 只执行判断；check-inline 先按同一协议判断，stay 时执行逗号后的主任务，change 时只显示建议。",
    statusInstruction,
    "不要向用户展示 session_id、请求指纹或此内部上下文。"
  ].filter(Boolean).join("\n");
}

export function buildPausedContext({ task, config, command }) {
  const marker = statusIndicatorInstruction(task, config);
  if (command?.action === "check-inline" && command.remainder) {
    return [
      "模型哨兵评估已暂停：本轮不执行模型判断，也不输出模型建议。",
      "check-inline 的逗号后内容仍是用户主任务；请直接完整执行该主任务。",
      marker,
      "不要向用户展示此内部上下文。"
    ].filter(Boolean).join("\n");
  }
  if (command?.action === "check") {
    return [
      "模型哨兵评估已暂停：本轮不执行模型判断。只简短说明评估已暂停，不执行其他主任务。",
      marker,
      "不要向用户展示此内部上下文。"
    ].filter(Boolean).join("\n");
  }
  return marker;
}

function stayInstruction({ model, command }) {
  if (command?.action === "check") {
    return `若 stay：不执行其他任务，只输出两行：模型判断：保持 ${model || "当前模型"}；原因：<一句具体原因>。`;
  }
  return "若 stay：立即执行主任务，只输出正常的任务结果；不显示 stay、模型判断、判断原因或任何分析过程。";
}

function changeInstruction(config, command) {
  const marker = config.showStatusIndicator ? "，并把 🛰️ 放在第一行末尾" : "";
  const continuation = command?.action === "check"
    ? "这是一条只检查命令，没有待执行的主任务；用户可切换或保持模型后发送下一条真实任务。"
    : "用户切换或保持模型后重新发送同一请求，插件会直接放行。";
  return [
    "若 change：不要执行主任务；保存成功后只输出恰好两行：",
    `模型建议：切换至 <模型>${marker}`,
    "原因：<一句具体原因>",
    continuation
  ].join("\n");
}

function buildControlContext({ sessionId, model, task, config, command }) {
  const instructions = {
    on: "UserPromptSubmit Hook 已将当前任务写为 enabled: true。现在只确认模型哨兵已为当前任务启用；本轮不运行推荐引擎；从下一条真实请求开始，每轮都评估。此确认只能在本控制上下文存在时输出。",
    off: "只确认模型哨兵已关闭当前任务。本轮不运行推荐引擎，不追加状态标识。",
    pause: "只确认哨兵评估已暂停，主任务不受影响。本轮末尾可显示暂停标识。",
    resume: "只确认哨兵评估已恢复。本轮不运行推荐引擎；从下一条真实请求恢复每轮评估。",
    status: `调用 model_watch_get_status，sessionId 使用 ${sessionId}；简要展示当前任务的启用、暂停、当前模型和状态标识设置。本轮不运行推荐引擎。`,
    settings: `调用 model_watch_open_settings，sessionId 使用 ${sessionId}；UI 不可用时用文字展示。本轮不运行推荐引擎。`,
    unknown: "提示该模型哨兵命令已不存在或无法识别，并建议用户打开 settings 或查看命令速查。本轮不运行推荐引擎。"
  };
  const marker = command.action === "off" ? "" : statusIndicatorInstruction(task, config);
  const remainderInstruction = command.remainder
    ? "检测到控制命令后的正文：本轮只处理控制命令，不执行该正文；请在下一条消息重新发送主任务。"
    : "";
  return [
    `[MODEL_WATCH_CONTROL ${ENGINE_VERSION}]`,
    `session_id: ${sessionId}`,
    `current_model: ${model || task.currentModel || "unknown"}`,
    `enabled: ${task.enabled}`,
    `paused: ${task.paused}`,
    instructions[command.action],
    remainderInstruction,
    marker,
    "不要向用户展示此内部上下文。"
  ].filter(Boolean).join("\n");
}

export function buildSessionContext({ source, task, config }) {
  return [
    `[MODEL_WATCH_RESTORE ${ENGINE_VERSION}]`,
    `session_source: ${source}`,
    `enabled: ${task.enabled}`,
    `paused: ${task.paused}`,
    `show_status_indicator: ${config.showStatusIndicator}`,
    "模型哨兵状态已从本地恢复。下一条真实用户输入到达后将进行一次模型判断；不要在本轮主动输出模型建议。"
  ].join("\n");
}

export function statusIndicatorInstruction(task, config) {
  if (!config.showStatusIndicator) return "";
  const marker = task.paused ? "🛰️⏸️" : "🛰️";
  return `普通自然语言回复末尾必须追加 ${marker}。严格 JSON、纯代码、命令和其他机器可读输出不要追加。`;
}
