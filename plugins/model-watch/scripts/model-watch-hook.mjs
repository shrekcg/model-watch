#!/usr/bin/env node
import { parseModelWatchCommand } from "../src/commands.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPrompt } from "../src/engine.mjs";
import { availableModelsFromEnv, modelIdsEqual } from "../src/models.mjs";
import {
  buildMonitoringContext,
  buildPausedContext,
  buildSessionContext
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

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function observeTicket(task, actualModel, routeMatched, resultOverride = null) {
  const ticket = task.routeTicket;
  if (!ticket) return;
  const result = resultOverride || (!routeMatched
    ? "superseded"
    : modelIdsEqual(actualModel, ticket.recommendedModel)
      ? "adopted"
      : modelIdsEqual(actualModel, ticket.originalModel)
        ? "kept"
        : "other");
  appendObservation(task, {
    result,
    assessmentId: ticket.assessmentId,
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
  if (command?.action === "off") {
    observeTicket(task, model || task.currentModel, false, "cancelled");
    task.enabled = false;
    task.paused = false;
    task.routeTicket = null;
  }
  if (command?.action === "pause") task.paused = true;
  if (command?.action === "resume") { task.enabled = true; task.paused = false; }

  if (!task.enabled && !command) return continueOutput("UserPromptSubmit");

  const promptHash = hashPrompt(command?.remainder || prompt);
  const routeExpired = Boolean(task.routeTicket?.expiresAt && Date.parse(task.routeTicket.expiresAt) <= Date.now());
  const routeMatched = Boolean(!routeExpired && task.routeTicket?.expiresAt
    && Date.parse(task.routeTicket.expiresAt) > Date.now()
    && task.routeTicket.promptHash === promptHash);
  if (task.routeTicket) {
    observeTicket(task, model, routeMatched, routeMatched ? null : routeExpired ? "expired" : "superseded");
    task.routeTicket = null;
  }
  const currentModel = model || task.currentModel;
  task.currentModel = currentModel;
  task.activeRequest = {
    turnId: String(input.turn_id || input.turnId || "unknown"),
    promptHash,
    originalModel: currentModel,
    commandAction: command?.action || null,
    createdAt: new Date().toISOString()
  };
  task = mutateTaskState(sessionId, () => task, dataDir);

  if (["on", "off", "pause", "resume", "status", "settings", "unknown"].includes(command?.action)) {
    return continueOutput(
      "UserPromptSubmit",
      buildMonitoringContext({
        sessionId,
        model,
        availableModels: availableModelsFromEnv(),
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
        availableModels: availableModelsFromEnv(),
        task,
        config,
        command,
        routeMatched: true
      })
    );
  }
  if (task.paused) {
    return continueOutput("UserPromptSubmit", buildPausedContext({ task, config, command }));
  }
  return continueOutput(
    "UserPromptSubmit",
    buildMonitoringContext({
      sessionId,
      model,
      availableModels: availableModelsFromEnv(),
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
  // Hooks may inherit a user-workspace cwd while MCP starts from PLUGIN_ROOT.
  // Anchor both processes at the installed plugin root before resolving data.
  const dataDir = resolveDataDir(process.env, PLUGIN_ROOT);
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
