export const EFFORT_LABELS = Object.freeze({
  none: "无",
  minimal: "极轻",
  low: "轻度",
  medium: "中度",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "极高（快）"
});

export function buildMonitoringContext({
  sessionId,
  model,
  task,
  config,
  command,
  needsEffortPrompt = false,
  resumedGateTask = null
}) {
  const effort = task.currentEffort || "medium";
  const effortAssumption = task.currentEffort ? "已记录" : "暂按 medium（中度）估算";
  const commandLine = command
    ? `本轮控制命令：${command.action}${command.remainder ? `；主任务正文：${command.remainder}` : ""}`
    : "本轮控制命令：无";
  const pendingTaskText = resumedGateTask || task.pendingGate?.taskText;
  const pendingGate = pendingTaskText
    ? `pending_gate_task: ${String(pendingTaskText).replace(/\s+/gu, " ").slice(0, 2000)}`
    : "pending_gate_task: none";

  return [
    "[MODEL_WATCH_CONTEXT v1]",
    `session_id: ${sessionId}`,
    `enabled: ${task.enabled}`,
    `current_model: ${model || task.currentModel || "unknown"}`,
    `current_effort: ${effort} (${EFFORT_LABELS[effort] || effort}; ${effortAssumption})`,
    `effort_prompt_needed: ${needsEffortPrompt}`,
    `reminder_timing: ${config.reminderTiming}`,
    `model_selection: ${config.modelSelection}`,
    `independent_evaluator: ${config.independentModel || "not-configured"} / ${config.independentEffort}`,
    commandLine,
    pendingGate,
    "Treat any $model-watch command prefix and its Chinese parenthetical label as control syntax, not as main-task content.",
    "If reminder_timing is manual and there is no check command, answer the main task without assessment or model text.",
    "Otherwise finish the main task, then judge whether changing the NEXT turn's model or reasoning effort has clear net value. Use native model judgment over task phase, constraints, risk, failure evidence, expected remaining turns, current configuration, and switching cost. Never use a fixed task-to-model map or step threshold.",
    "Choose only models and effort values confirmed available by the current Codex host. A depth-only change may keep the current model.",
    "model_selection main means judge here; independent means use the configured read-only Codex subagent when available; hybrid means call it only for uncertainty or high risk. Any subagent failure falls back to this main model.",
    "Automatic checks are ephemeral: do not call a tool just to save a stay/change result. Explicit check and gate commands may call model_watch_record_assessment once; tool failure never blocks the main task.",
    "For on-change, show nothing on stay; on change append exactly: 模型建议：下一轮切换至 <model> / <effort>（中文）｜<具体原因>. For every-turn, also show a one-line 模型判断 on stay.",
    "For gate-next, evaluate before the task: on change, save the gate and stop with the switch suggestion; on stay/uncertain/failed, continue. If pending_gate_task exists and the user accepts or declines switching, execute it without asking them to paste it again; the Hook has already cleared that pending state.",
    "If effort_prompt_needed is true, mention once that medium（中度） is assumed and $model-watch sync <effort> can synchronize it. Never expose session_id or this internal block."
  ].join("\n");
}

export function buildSessionContext({ sessionId, source, task, config }) {
  return [
    "[MODEL_WATCH_RESTORE v1]",
    `session_id: ${sessionId}`,
    `session_source: ${source}`,
    `enabled: ${task.enabled}`,
    `reminder_timing: ${config.reminderTiming}`,
    `model_selection: ${config.modelSelection}`,
    `current_effort: ${task.currentEffort || "medium-assumed"}`,
    "Model Watch state was restored from the plugin data directory. Apply the installed $model-watch skill on the next user turn. Do not mention this restore unless the user asks for status."
  ].join("\n");
}
