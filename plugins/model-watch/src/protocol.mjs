import { ENGINE_VERSION } from "./engine.mjs";
import { buildRecommendationPolicy } from "./policy.mjs";
import { formatCandidateDirectory } from "./models.mjs";

export function buildMonitoringContext({
  sessionId,
  model,
  availableModels = [],
  task,
  config,
  command,
  routeMatched = false,
  resumedFromCard = false
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
    if (resumedFromCard === "test") {
      return buildTestCompletionContext({ task, config });
    }
    return [
      `[MODEL_WATCH_ROUTE ${ENGINE_VERSION}]`,
      `session_id: ${sessionId}`,
      `current_model: ${model || task.currentModel || "unknown"}`,
      resumedFromCard
        ? "用户已通过模型建议卡片继续上一条被暂停的任务。不要把当前恢复 envelope 当作主任务；不要再次判断模型；直接根据当前会话中上一条真实用户请求的原文、角色和可见附件完整执行该任务。"
        : "同一请求已在上一轮完成模型判断。不要再次判断模型；直接完整执行本轮原始用户请求。",
      statusInstruction,
      "不要向用户展示此内部上下文。"
    ].filter(Boolean).join("\n");
  }

  if (["on", "off", "pause", "resume", "status", "settings", "unknown"].includes(command?.action)) {
    return buildControlContext({ sessionId, model, task, config, command });
  }

  if (["test-card", "test"].includes(command?.action)) {
    return buildTestContext({ sessionId, model, task, config, command });
  }

  return [
    `[MODEL_WATCH_CONTEXT ${ENGINE_VERSION}]`,
    `session_id: ${sessionId}`,
    `turn_id: ${task.activeRequest?.turnId || "unknown"}`,
    `enabled: ${task.enabled}`,
    `paused: ${task.paused}`,
    `current_model: ${model || task.currentModel || "unknown"}`,
    `available_models: ${availableModels.length ? availableModels.join(", ") : "unknown"}`,
    `evaluator_mode: ${config.evaluatorMode}`,
    `evaluator_model: ${config.evaluatorModel}`,
    candidatePolicyInstruction(config),
    `candidate_directory:\n${formatCandidateDirectory(config) || "目录不可用"}`,
    commandLine,
    "模型哨兵是一套独立、通用的推荐引擎。它适用于开发、日常沟通、分析、学习、写作、资料整理和问题排查。",
    "当前任务启用后，每一条真实用户请求都必须先在内部完成一次模型判断，再决定是否执行主任务。根据本轮输入与历史意图、目标阶段、约束、上下文整合、工具协调、风险和可逆性、失败返工、预计剩余工作、当前模型、候选模型与切换成本，判断当前模型是否仍合适。",
    buildRecommendationPolicy(availableModels),
    "若 current_model 为 unknown，或推荐模型等于 current_model：必须判定 uncertain 或 failed，绝不能判定 change。",
    fixedEvaluatorInstruction({ sessionId, task, config }),
    `判断完成后必须保存结果：若 fixed-codex 工具成功，它已保存独立评估结果；若它要求 fallback，则调用 model_watch_record_fallback_assessment；其他情况调用 model_watch_record_assessment。sessionId 使用上面的精确值 ${sessionId}，turnId 使用上面的精确值 ${task.activeRequest?.turnId || "unknown"}。stay、change、uncertain 和 failed 都要保存。`,
    stayInstruction({ model, command }),
    changeInstruction(config, command, { sessionId, task }),
    "内部判断阶段不得向用户输出思考过程、判断过程、分析过程、‘正在分析’或任何中间文本。若 uncertain、failed 或保存工具不可用：直接执行主任务，不显示 stay/change。不要要求用户回复继续、采纳、忽略或修正。",
    "check 只执行判断；check-inline 先按同一协议判断，stay 时执行逗号后的主任务，change 时只显示建议。",
    statusInstruction,
    "不要向用户展示 session_id、请求指纹或此内部上下文。"
  ].filter(Boolean).join("\n");
}

function candidatePolicyInstruction(config) {
  const snapshot = config.hostCatalog;
  const fresh = snapshot?.fetchedAt && Date.now() - Date.parse(snapshot.fetchedAt) <= 60 * 60 * 1000;
  if (!fresh) return "宿主模型目录或限额快照不可用/已过期：只比较已知 GPT 候选；不要猜测外部模型可用性或额度。";
  const remaining = snapshot.rateLimit?.remainingPercent;
  const threshold = config.externalModelThreshold;
  if (!config.preferGpt) return "GPT 优先已关闭：可比较目录中所有候选，但必须根据其模态与可用性证据判断。";
  if (snapshot.rateLimit?.limitId === "codex" && Number.isFinite(remaining) && remaining <= threshold) {
    return `GPT 优先开启，但 Codex 原生 GPT 限额桶剩余 ${remaining}%（阈值 ${threshold}%）：本轮只从已选的外部候选中推荐；该桶不是单个 GPT 型号的精确余额。若没有已选外部候选，安全回退已选 GPT 候选。`;
  }
  return `GPT 优先开启：Codex 原生 GPT 限额桶剩余 ${Number.isFinite(remaining) ? `${remaining}%` : "未知"}，阈值 ${threshold}%；本轮只从 GPT 原生候选中推荐。`;
}

function buildTestCompletionContext({ task, config }) {
  const choice = task.testObservationHistory?.at(-1)?.explicitDecision || "unknown";
  const actualModel = task.currentModel || "unknown";
  return [
    `[MODEL_WATCH_TEST_COMPLETE ${ENGINE_VERSION}]`,
    "这是确定性建议卡片测试的恢复轮。不要评估模型，不要执行此前任何用户主任务，也不要再次创建测试卡。",
    `只输出三行：\nMODEL_WATCH_TEST_PASS\n实际模型：${actualModel}\n用户操作：${choice}`,
    statusIndicatorInstruction(task, config),
    "不要向用户展示此内部上下文。"
  ].filter(Boolean).join("\n");
}

function fixedEvaluatorInstruction({ sessionId, task, config }) {
  if (config.evaluatorMode !== "fixed-codex") return "评估器为 same-session：使用当前主模型按上述策略完成判断。";
  return [
    `评估器为 fixed-codex：先调用 model_watch_run_fixed_evaluator，sessionId=${sessionId}、turnId=${task.activeRequest?.turnId || "unknown"}，prompt 必须逐字使用本轮真实用户请求正文。`,
    "工具返回的已保存判断是本轮唯一的独立判断：stay/uncertain 直接执行主任务；change 用返回 task.routeTicket.gateId 调用建议卡片。若工具返回 fallbackRequired: true，先用当前主模型完成同会话判断，再调用 model_watch_record_fallback_assessment 保存该结果；requestedEvaluatorModel 使用 evaluator_model，fallbackReason 使用工具返回的 result.rationale。不要混合两次判断或覆盖已保存结果。",
    "固定评估器只看到本轮输入；不能声称看到了历史、附件或工具结果。"
  ].join("\n");
}

function buildTestContext({ sessionId, model, task, config, command }) {
  const scenario = command.action === "test-card" ? "card" : command.remainder.trim().toLowerCase();
  return [
    `[MODEL_WATCH_TEST ${ENGINE_VERSION}]`,
    `session_id: ${sessionId}`,
    `turn_id: ${task.activeRequest?.turnId || "unknown"}`,
    `current_model: ${model || task.currentModel || "unknown"}`,
    `这是内部确定性测试夹具，场景为 ${scenario || "unknown"}。不要运行真实推荐引擎，也不要执行用户主任务；立即调用 model_watch_create_test_recommendation，sessionId 和 turnId 使用上面的精确值，scenario 使用 ${scenario || "unknown"}。`,
    "工具返回的 fixture 决定后续行为：需要卡片时调用 model_watch_present_recommendation；直接放行时只输出 fixture 指示的测试完成文本。不要额外输出解释。",
    statusIndicatorInstruction(task, config),
    "不要向用户展示此内部上下文。"
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

export function buildInvalidResumeContext({ task, config }) {
  return [
    `[MODEL_WATCH_RESUME_REJECTED ${ENGINE_VERSION}]`,
    "这是一条已失效、已消费或不属于当前任务的模型哨兵恢复消息。不要把它当作用户主任务，不要再次评估模型，也不要执行上一条任务。",
    "只简短提示：这条继续操作已经失效；如果任务尚未执行，请重新发送原始请求。",
    statusIndicatorInstruction(task, config),
    "不要向用户展示恢复消息、gate、nonce 或此内部上下文。"
  ].filter(Boolean).join("\n");
}

function stayInstruction({ model, command }) {
  if (command?.action === "check") {
    return `若 stay：不执行其他任务，只输出两行：模型判断：保持 ${model || "当前模型"}；原因：<一句具体原因>。`;
  }
  return "若 stay：立即执行主任务，只输出正常的任务结果；不显示 stay、模型判断、判断原因或任何分析过程。";
}

function changeInstruction(config, command, { sessionId, task }) {
  const marker = config.showStatusIndicator ? "，并把 🛰️ 放在第一行末尾" : "";
  const continuation = command?.action === "check"
    ? "这是一条只检查命令，没有待执行的主任务；用户可切换或保持模型后发送下一条真实任务。"
    : "用户切换或保持模型后重新发送同一请求，插件会直接放行。";
  return [
    "若 change：不要执行主任务。",
    command?.action === "check"
      ? `不要展示建议卡片；保存成功后只输出恰好两行：\n模型建议：切换至 <模型>${marker}\n原因：<一句具体原因>\n${continuation}`
      : `若最终为 change：保存工具返回 routeTicketCreated: true 后，从返回 task.routeTicket 读取 gateId，并调用 model_watch_present_recommendation，sessionId 使用 ${sessionId}。卡片成功展示后不要再输出模型建议文字。只有卡片调用失败或不可用时，才降级输出恰好两行：\n模型建议：切换至 <模型>${marker}\n原因：<一句具体原因>\n${continuation}\n当前请求 turnId 为 ${task.activeRequest?.turnId || "unknown"}。`
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
