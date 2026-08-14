#!/usr/bin/env node
import { parseModelWatchCommand } from "../src/commands.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPrompt } from "../src/engine.mjs";
import { availableModelsForConfig, modelIdsEqual } from "../src/models.mjs";
import {
  buildInvalidResumeContext,
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

function parseResumeEnvelope(prompt) {
  const match = String(prompt || "").trim().match(/^\[MODEL_WATCH_RESUME\s+gate=([a-zA-Z0-9-]{1,80})\s+nonce=([a-zA-Z0-9-]{1,100})\]$/u);
  return match ? { gateId: match[1], resumeNonce: match[2] } : null;
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
    explicitDecision: ticket.explicitDecision,
    originalModel: ticket.originalModel,
    recommendedModel: ticket.recommendedModel,
    actualModel,
    source: ticket.source
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
  const resumeEnvelope = parseResumeEnvelope(prompt);
  const existed = taskStateExists(sessionId, dataDir);
  const initialTask = loadTaskState(sessionId, dataDir);
  if (!initialTask.enabled && !command && !resumeEnvelope
    && !( !existed && loadGlobalConfig(dataDir).autoEnableNewTasks)) {
    return continueOutput("UserPromptSubmit");
  }
  const promptHash = hashPrompt(command?.remainder || prompt);
  let routeMatched = false;
  let cardResumeMatched = false;
  let routeSource = "live";
  let invalidCardResume = false;
  let task = mutateTaskState(sessionId, (draft) => {
    if (!existed && loadGlobalConfig(dataDir).autoEnableNewTasks) draft.enabled = true;
    if (command?.action === "on") { draft.enabled = true; draft.paused = false; }
    if (command?.action === "off") {
      observeTicket(draft, model || draft.currentModel, false, "cancelled");
      draft.enabled = false;
      draft.paused = false;
      draft.routeTicket = null;
    }
    if (command?.action === "pause") draft.paused = true;
    if (command?.action === "resume") { draft.enabled = true; draft.paused = false; }

    const routeExpired = Boolean(draft.routeTicket?.expiresAt && Date.parse(draft.routeTicket.expiresAt) <= Date.now());
    cardResumeMatched = Boolean(!routeExpired && resumeEnvelope && draft.routeTicket?.status === "armed"
      && draft.routeTicket.gateId === resumeEnvelope.gateId
      && draft.routeTicket.resumeNonce === resumeEnvelope.resumeNonce);
    invalidCardResume = Boolean(resumeEnvelope && !cardResumeMatched);
    const manualResumeMatched = Boolean(!resumeEnvelope && !routeExpired && draft.routeTicket?.expiresAt
      && Date.parse(draft.routeTicket.expiresAt) > Date.now()
      && draft.routeTicket.promptHash === promptHash);
    routeMatched = cardResumeMatched || manualResumeMatched;
    routeSource = draft.routeTicket?.source || "live";
    if (draft.routeTicket && !invalidCardResume) {
      observeTicket(draft, model, routeMatched, routeMatched ? null : routeExpired ? "expired" : "superseded");
      draft.routeTicket = null;
    }
    if (invalidCardResume) return draft;
    const currentModel = model || draft.currentModel;
    draft.currentModel = currentModel;
    draft.activeRequest = {
      turnId: String(input.turn_id || input.turnId || "unknown"),
      promptHash,
      originalModel: currentModel,
      commandAction: command?.action || null,
      createdAt: new Date().toISOString()
    };
    return draft;
  }, dataDir);

  if (invalidCardResume) {
    return continueOutput(
      "UserPromptSubmit",
      buildInvalidResumeContext({ task, config: getEffectiveConfig(sessionId, dataDir) })
    );
  }
  if (!task.enabled && !command && !routeMatched) return continueOutput("UserPromptSubmit");

  if (["on", "off", "pause", "resume", "status", "settings", "unknown", "test-card", "test"].includes(command?.action)) {
    return continueOutput(
      "UserPromptSubmit",
      buildMonitoringContext({
        sessionId,
        model,
        availableModels: availableModelsForConfig(getEffectiveConfig(sessionId, dataDir)),
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
        availableModels: availableModelsForConfig(config),
        task,
        config,
        command,
        routeMatched: true,
        resumedFromCard: cardResumeMatched ? routeSource : false
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
      availableModels: availableModelsForConfig(config),
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
