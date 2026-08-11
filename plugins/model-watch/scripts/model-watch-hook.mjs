#!/usr/bin/env node
import { parseModelWatchCommand } from "../src/commands.mjs";
import { buildMonitoringContext, buildSessionContext } from "../src/protocol.mjs";
import {
  getEffectiveConfig,
  loadGlobalConfig,
  loadTaskState,
  resolveDataDir,
  saveTaskState,
  taskStateExists,
  validateEffort
} from "../src/state.mjs";

async function readInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input.trim() ? JSON.parse(input) : {};
}

function output(eventName, additionalContext) {
  process.stdout.write(`${JSON.stringify({
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext
    }
  })}\n`);
}

function sessionIdFrom(input) {
  return String(input.session_id || input.sessionId || "unknown");
}

function handleSessionStart(input, dataDir) {
  const sessionId = sessionIdFrom(input);
  const source = String(input.source || "startup");
  const existed = taskStateExists(sessionId, dataDir);
  const globalConfig = loadGlobalConfig(dataDir);
  let task = loadTaskState(sessionId, dataDir);

  if (!existed && globalConfig.autoEnableNewTasks) {
    task = saveTaskState(sessionId, { ...task, enabled: true }, dataDir);
  }
  if (!task.enabled) return output("SessionStart", "");

  const config = getEffectiveConfig(sessionId, dataDir);
  return output("SessionStart", buildSessionContext({ sessionId, source, task, config }));
}

function handleUserPrompt(input, dataDir) {
  const sessionId = sessionIdFrom(input);
  const prompt = String(input.prompt || "");
  const model = typeof input.model === "string" ? input.model : null;
  const command = parseModelWatchCommand(prompt);
  let task = loadTaskState(sessionId, dataDir);
  const needsEffortPrompt =
    !task.currentEffort && !task.effortPrompted && (task.enabled || command?.action === "on");

  if (model && model !== task.currentModel) task.currentModel = model;

  const shouldResumeGate =
    !command &&
    Boolean(task.pendingGate?.taskText) &&
    /(?:^|[，。！？\s])(继续|已切换|切好了|不切换|不切|保持当前|continue|keep)(?:$|[，。！？\s])/iu.test(prompt);
  const resumedGateTask = shouldResumeGate ? task.pendingGate.taskText : null;
  if (shouldResumeGate) task.pendingGate = null;

  if (!task.enabled && !command && !resumedGateTask) return output("UserPromptSubmit", "");

  if (command?.action === "on") task.enabled = true;
  if (command?.action === "off") {
    task.enabled = false;
    task.pendingGate = null;
  }
  if (command?.action === "sync") {
    try {
      task.currentEffort = validateEffort(command.argument);
      task.effortSource = "user";
      task.effortPrompted = true;
    } catch {
      // The model will explain valid values through the injected command context.
    }
  }
  if (command?.action === "gate-next" && command.remainder) {
    task.pendingGate = {
      status: "evaluating",
      taskText: command.remainder.slice(0, 4000),
      createdAt: new Date().toISOString()
    };
  }

  if (needsEffortPrompt && command?.action !== "sync") {
    task.effortPrompted = true;
  }

  task = saveTaskState(sessionId, task, dataDir);
  const explicitCommand = Boolean(command);
  if (!task.enabled && !explicitCommand && !resumedGateTask) {
    return output("UserPromptSubmit", "");
  }

  const config = getEffectiveConfig(sessionId, dataDir);
  const context = buildMonitoringContext({
    sessionId,
    model,
    task,
    config,
    command,
    needsEffortPrompt,
    resumedGateTask
  });
  return output("UserPromptSubmit", context);
}

function handleCompact(input, dataDir, eventName) {
  const sessionId = sessionIdFrom(input);
  const task = loadTaskState(sessionId, dataDir);
  if (!task.enabled) return output(eventName, "");
  const config = getEffectiveConfig(sessionId, dataDir);
  return output(
    eventName,
    buildSessionContext({ sessionId, source: eventName.toLowerCase(), task, config })
  );
}

try {
  const input = await readInput();
  const dataDir = resolveDataDir();
  const eventName = String(input.hook_event_name || input.hookEventName || "");

  if (eventName === "SessionStart") handleSessionStart(input, dataDir);
  else if (eventName === "UserPromptSubmit") handleUserPrompt(input, dataDir);
  else if (eventName === "PreCompact" || eventName === "PostCompact") {
    handleCompact(input, dataDir, eventName);
  } else output(eventName || "UserPromptSubmit", "");
} catch (error) {
  process.stderr.write(`model-watch hook warning: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true })}\n`);
}
