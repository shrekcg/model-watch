#!/usr/bin/env node
import { parseModelWatchCommand } from "../src/commands.mjs";
import { hashPrompt } from "../src/engine.mjs";
import {
  buildMonitoringContext,
  buildSessionContext,
  statusIndicatorInstruction
} from "../src/protocol.mjs";
import {
  appendObservation,
  getEffectiveConfig,
  loadGlobalConfig,
  loadTaskState,
  mutateTaskState,
  resolveDataDir,
  taskStateExists
} from "../src/state.mjs";

const DEFAULT_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];

async function readInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input.trim() ? JSON.parse(input) : {};
}

function continueOutput(eventName, additionalContext = "") {
  process.stdout.write(`${JSON.stringify({
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: eventName, additionalContext }
  })}\n`);
}

function sessionIdFrom(input) {
  return String(input.session_id || input.sessionId || "unknown");
}

function modelFrom(input) {
  const candidates = [input.model, input.model_slug, input.modelSlug, input.active_model, input.activeModel];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function availableModels() {
  const configured = String(process.env.MODEL_WATCH_AVAILABLE_MODELS || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return configured.length ? [...new Set(configured)] : DEFAULT_MODELS;
}

function observeTicket(task, actualModel, routeMatched) {
  const ticket = task.routeTicket;
  if (!ticket) return;
  const result = !routeMatched
    ? "superseded"
    : actualModel === ticket.recommendedModel
      ? "adopted"
      : actualModel === ticket.originalModel
        ? "kept"
        : "other";
  appendObservation(task, {
    result,
    originalModel: ticket.originalModel,
    recommendedModel: ticket.recommendedModel,
    actualModel
  });
}

function handleSessionStart(input, dataDir) {
  const sessionId = sessionIdFrom(input);
  const source = String(input.source || "startup");
  const model = modelFrom(input);
  const existed = taskStateExists(sessionId, dataDir);
  const global = loadGlobalConfig(dataDir);
  let task = loadTaskState(sessionId, dataDir);
  if (model || (!existed && global.autoEnableNewTasks)) {
    task = mutateTaskState(sessionId, (draft) => ({
      ...draft,
      enabled: !existed && global.autoEnableNewTasks ? true : draft.enabled,
      currentModel: model || draft.currentModel
    }), dataDir);
  }
  if (!task.enabled) return continueOutput("SessionStart");
  return continueOutput(
    "SessionStart",
    buildSessionContext({ source, task, config: getEffectiveConfig(sessionId, dataDir) })
  );
}

async function handleUserPrompt(input, dataDir) {
  if (process.env.MODEL_WATCH_BYPASS === "1") return continueOutput("UserPromptSubmit");
  const sessionId = sessionIdFrom(input);
  const prompt = String(input.prompt || "");
  const model = modelFrom(input);
  const command = parseModelWatchCommand(prompt);
  const existed = taskStateExists(sessionId, dataDir);
  let task = loadTaskState(sessionId, dataDir);
  if (!existed && loadGlobalConfig(dataDir).autoEnableNewTasks) task.enabled = true;

  if (command?.action === "on") { task.enabled = true; task.paused = false; }
  if (command?.action === "off") { task.enabled = false; task.paused = false; task.routeTicket = null; }
  if (command?.action === "pause") task.paused = true;
  if (command?.action === "resume") { task.enabled = true; task.paused = false; }

  if (!task.enabled && !command) return continueOutput("UserPromptSubmit");

  const promptHash = hashPrompt(command?.remainder || prompt);
  const routeMatched = Boolean(task.routeTicket?.promptHash === promptHash);
  if (task.routeTicket) {
    observeTicket(task, model, routeMatched);
    task.routeTicket = null;
  }
  const currentModel = model || task.currentModel;
  task.currentModel = currentModel;
  task.activeRequest = {
    turnId: String(input.turn_id || input.turnId || "unknown"),
    promptHash,
    originalModel: currentModel,
    createdAt: new Date().toISOString()
  };
  task = mutateTaskState(sessionId, () => task, dataDir);

  if (["on", "off", "pause", "resume", "status", "settings", "unknown"].includes(command?.action)) {
    return continueOutput(
      "UserPromptSubmit",
      buildMonitoringContext({
        sessionId,
        model,
        availableModels: availableModels(),
        task,
        config: getEffectiveConfig(sessionId, dataDir),
        command
      })
    );
  }
  const config = getEffectiveConfig(sessionId, dataDir);
  if (routeMatched) {
    return continueOutput(
      "UserPromptSubmit",
      buildMonitoringContext({
        sessionId,
        model,
        availableModels: availableModels(),
        task,
        config,
        command,
        routeMatched: true
      })
    );
  }
  if (task.paused) {
    return continueOutput("UserPromptSubmit", statusIndicatorInstruction(task, config));
  }
  return continueOutput(
    "UserPromptSubmit",
    buildMonitoringContext({
      sessionId,
      model,
      availableModels: availableModels(),
      task,
      config,
      command
    })
  );
}

function handleCompact(input, dataDir, eventName) {
  const sessionId = sessionIdFrom(input);
  const task = loadTaskState(sessionId, dataDir);
  if (!task.enabled) return continueOutput(eventName);
  return continueOutput(
    eventName,
    buildSessionContext({
      source: eventName.toLowerCase(),
      task,
      config: getEffectiveConfig(sessionId, dataDir)
    })
  );
}

try {
  const input = await readInput();
  const dataDir = resolveDataDir();
  const eventName = String(input.hook_event_name || input.hookEventName || "");
  if (eventName === "SessionStart") handleSessionStart(input, dataDir);
  else if (eventName === "UserPromptSubmit") await handleUserPrompt(input, dataDir);
  else if (eventName === "PreCompact" || eventName === "PostCompact") {
    handleCompact(input, dataDir, eventName);
  } else continueOutput(eventName || "UserPromptSubmit");
} catch (error) {
  process.stderr.write(`model-watch hook warning: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true })}\n`);
}
