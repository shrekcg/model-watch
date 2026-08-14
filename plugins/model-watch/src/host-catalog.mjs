import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const APP_SERVER = "/Applications/ChatGPT.app/Contents/Resources/codex";
const TIMEOUT_MS = 20_000;

// This adapter is invoked only from an explicit settings refresh. Hooks consume
// the persisted snapshot and never start an app-server process on every turn.
export async function refreshHostCatalog({ env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  const fixture = env.MODEL_WATCH_HOST_CATALOG_JSON;
  if (fixture) return normalizeSnapshot(JSON.parse(fixture));
  if (!existsSync(APP_SERVER)) throw new Error("未找到本机 Codex app-server。\n");
  const rpc = await requestAppServer(timeoutMs);
  const [models, limits] = await Promise.all([
    rpc.request("model/list", { includeHidden: false, limit: 100 }),
    rpc.request("account/rateLimits/read", null)
  ]);
  rpc.close();
  return normalizeSnapshot({ models: models?.data, rateLimits: limits?.rateLimitsByLimitId?.codex || limits?.rateLimits });
}

function normalizeSnapshot(value) {
  const rawModels = Array.isArray(value?.models) ? value.models : [];
  const models = rawModels
    .filter((model) => model && !model.hidden && typeof model.id === "string" && model.id.trim())
    .map((model) => ({
      id: model.id.trim(),
      displayName: typeof model.displayName === "string" ? model.displayName.slice(0, 160) : model.id.trim(),
      provider: model.id.trim().toLowerCase().startsWith("gpt-") ? "gpt" : "external",
      inputModalities: Array.isArray(model.inputModalities)
        ? [...new Set(model.inputModalities.filter((item) => ["text", "image", "audio"].includes(item)))].slice(0, 3)
        : [],
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.map((item) => item?.reasoningEffort).filter((item) => typeof item === "string").slice(0, 8)
        : []
    }))
    .slice(0, 50);
  const usedPercent = finitePercent(value?.rateLimits?.primary?.usedPercent);
  return {
    source: "codex-app-server",
    fetchedAt: new Date().toISOString(),
    models,
    rateLimit: {
      limitId: stringOrNull(value?.rateLimits?.limitId),
      usedPercent,
      remainingPercent: usedPercent === null ? null : 100 - usedPercent,
      resetsAt: Number.isInteger(value?.rateLimits?.primary?.resetsAt) ? value.rateLimits.primary.resetsAt : null,
      windowDurationMins: Number.isInteger(value?.rateLimits?.primary?.windowDurationMins) ? value.rateLimits.primary.windowDurationMins : null,
      planType: stringOrNull(value?.rateLimits?.planType)
    }
  };
}

function requestAppServer(timeoutMs) {
  const child = spawn(APP_SERVER, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const close = (reason = new Error("宿主目录连接已关闭")) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    child.kill("SIGTERM");
    for (const entry of pending.values()) entry.reject(reason);
    pending.clear();
  };
  const fail = (error) => { close(); throw error; };
  const timer = setTimeout(() => close(new Error(`读取宿主目录超时（${timeoutMs}ms）`)), timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || "宿主目录请求失败"));
        else entry.resolve(message.result);
      } catch { /* app-server may emit non-protocol diagnostics */ }
    }
  });
  child.on("error", (error) => close(error));
  child.on("exit", (code, signal) => {
    if (!closed) close(new Error(`宿主目录进程提前退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`));
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
      if (error && pending.delete(id)) reject(error);
    });
  });
  return request("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "model-watch", version: "1.1.2" },
    capabilities: {}
  })
    .then(() => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
      return { request, close };
    })
    .catch(fail);
}

function finitePercent(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}
