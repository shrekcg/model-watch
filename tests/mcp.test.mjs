import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const serverPath = resolve(import.meta.dirname, "../plugins/model-watch/scripts/model-watch-mcp.mjs");
const pluginRoot = resolve(import.meta.dirname, "../plugins/model-watch");

function loadBundledMcpConfig() {
  const config = JSON.parse(readFileSync(resolve(pluginRoot, ".mcp.json"), "utf8"));
  return config.mcpServers["model-watch"];
}

function createClient(dataDir, envPatch = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...envPatch, MODEL_WATCH_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
      index = buffer.indexOf("\n");
    }
  });

  let nextId = 1;
  return {
    child,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error(`MCP timeout for ${method}`)), 3000);
        pending.set(id, (message) => {
          clearTimeout(timeout);
          resolvePromise(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    }
  };
}

test("bundled MCP config starts from the installed plugin root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-bundled-mcp-"));
  const config = loadBundledMcpConfig();
  assert.equal(config.cwd, ".");
  assert.deepEqual(config.args, ["./scripts/model-watch-mcp.mjs"]);
  assert.doesNotMatch(JSON.stringify(config), /PLUGIN_ROOT/);

  const child = spawn(config.command, config.args, {
    cwd: pluginRoot,
    env: { ...process.env, MODEL_WATCH_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
    })}\n`);

    const deadline = Date.now() + 3000;
    while (!stdout.includes("\n") && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    const initialized = JSON.parse(stdout.trim().split("\n")[0]);
    assert.equal(initialized.result.serverInfo.name, "model-watch");
  } finally {
    child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP server exposes settings UI and persists task configuration", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-mcp-"));
  const client = createClient(dataDir);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    });
    assert.equal(initialized.result.serverInfo.name, "model-watch");

    const listed = await client.request("tools/list");
    const settingsTool = listed.result.tools.find((tool) => tool.name === "model_watch_open_settings");
    assert.equal(settingsTool._meta.ui.resourceUri, "ui://model-watch/settings-v8.html");
    const recommendationTool = listed.result.tools.find((tool) => tool.name === "model_watch_present_recommendation");
    assert.equal(recommendationTool._meta.ui.resourceUri, "ui://model-watch/recommendation-v1.html");
    assert.ok(listed.result.tools.find((tool) => tool.name === "model_watch_create_test_recommendation"));
    assert.ok(listed.result.tools.find((tool) => tool.name === "model_watch_run_fixed_evaluator"));
    assert.ok(listed.result.tools.find((tool) => tool.name === "model_watch_get_assessment_records"));
    assert.ok(listed.result.tools.find((tool) => tool.name === "model_watch_record_fallback_assessment"));
    assert.ok(listed.result.tools.find((tool) => tool.name === "model_watch_refresh_host_catalog"));

    const resource = await client.request("resources/read", { uri: "ui://model-watch/settings-v8.html" });
    assert.equal(resource.result.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(resource.result.contents[0].text, /模型哨兵设置/);
    assert.match(resource.result.contents[0].text, /按需启用：在要监测的对话中发送 !model-watch on/);
    assert.match(resource.result.contents[0].text, /pendingRequests/);
    assert.match(resource.result.contents[0].text, /data-tab="settings"/);
    assert.match(resource.result.contents[0].text, /id="globalAutoEnable" type="checkbox"/);
    assert.match(resource.result.contents[0].text, /id="taskEnabled" type="checkbox"/);
    assert.match(resource.result.contents[0].text, /<svg class="off" viewBox="0 0 44 24"/);
    assert.match(resource.result.contents[0].text, /固定工作流/);
    assert.match(resource.result.contents[0].text, /内部判断（不展示）/);
    assert.match(resource.result.contents[0].text, /启用后固定每轮评估/);
    assert.match(resource.result.contents[0].text, /id="taskStatusDot"/);
    assert.match(resource.result.contents[0].text, /id="assessmentSummary"/);
    assert.match(resource.result.contents[0].text, /id="recordsList"/);
    assert.match(resource.result.contents[0].text, /API 等价成本/);
    assert.match(resource.result.contents[0].text, /实际选择：尚未观察到/);
    assert.match(resource.result.contents[0].text, /id="globalStatusIndicator"/);
    assert.match(resource.result.contents[0].text, /id="taskPaused"/);
    assert.match(resource.result.contents[0].text, /id="globalEvaluatorMode"/);
    assert.match(resource.result.contents[0].text, /自定义评估模型/);
    assert.match(resource.result.contents[0].text, /参与推荐的模型/);
    assert.match(resource.result.contents[0].text, /id="globalPreferGpt"/);
    assert.match(resource.result.contents[0].text, /id="externalModelThreshold"/);
    assert.match(resource.result.contents[0].text, /id="refreshHostCatalog"/);
    assert.match(resource.result.contents[0].text, /Codex 限额桶/);
    assert.doesNotMatch(resource.result.contents[0].text, /查看测试指令/);
    assert.doesNotMatch(resource.result.contents[0].text, /推理深度/);
    assert.doesNotMatch(resource.result.contents[0].text, /gate-next/);
    assert.match(resource.result.contents[0].text, /id="saveSettings"/);

    const recommendation = await client.request("resources/read", { uri: "ui://model-watch/recommendation-v1.html" });
    assert.match(recommendation.result.contents[0].text, /已选择模型，继续任务/);
    assert.match(recommendation.result.contents[0].text, /忽略建议，继续任务/);
    assert.match(recommendation.result.contents[0].text, /sendFollowUpMessage/);
    assert.doesNotMatch(recommendation.result.contents[0].text, /method:"ui\/message"/);

    const updated = await client.request("tools/call", {
      name: "model_watch_update_settings",
      arguments: {
        scope: "task",
        sessionId: "mcp-task",
        patch: { enabled: true, paused: true }
      }
    });
    assert.equal(updated.result.structuredContent.task.enabled, true);
    assert.equal(updated.result.structuredContent.task.paused, true);
    const globalUpdated = await client.request("tools/call", {
      name: "model_watch_update_settings",
      arguments: {
        scope: "global",
        patch: {
          evaluatorMode: "fixed-codex",
          evaluatorModel: "gpt-5.6-sol",
          showStatusIndicator: false,
          externalModelThreshold: 50
        }
      }
    });
    assert.equal(globalUpdated.result.structuredContent.global.evaluatorMode, "fixed-codex");
    assert.equal(globalUpdated.result.structuredContent.global.evaluatorModel, "gpt-5.6-sol");
    assert.equal(globalUpdated.result.structuredContent.global.showStatusIndicator, false);
    assert.equal(globalUpdated.result.structuredContent.global.externalModelThreshold, 50);
    assert.deepEqual(updated.result.structuredContent.availableModels, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);

    const openedWithoutSession = await client.request("tools/call", {
      name: "model_watch_open_settings",
      arguments: {}
    });
    assert.equal(openedWithoutSession.result.structuredContent.sessionId, null);
    assert.equal(openedWithoutSession.result.structuredContent.task, null);

    const openedWithUnknownSession = await client.request("tools/call", {
      name: "model_watch_open_settings",
      arguments: { sessionId: "unknown" }
    });
    assert.equal(openedWithUnknownSession.result.structuredContent.sessionId, null);
    assert.equal(openedWithUnknownSession.result.structuredContent.task, null);
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP refreshes a supplied host catalog and applies the saved threshold", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-catalog-"));
  const fixture = JSON.stringify({
    models: [
      { id: "gpt-5.6-luna", displayName: "GPT Luna", inputModalities: ["text", "image"] },
      { id: "opencode-go/deepseek-v4-pro", displayName: "DeepSeek V4 Pro", inputModalities: ["text", "image"] }
    ],
    rateLimits: { limitId: "codex", primary: { usedPercent: 65, windowDurationMins: 10080 } }
  });
  const client = createClient(dataDir, { MODEL_WATCH_HOST_CATALOG_JSON: fixture });
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const refreshed = await client.request("tools/call", { name: "model_watch_refresh_host_catalog", arguments: {} });
    assert.equal(refreshed.result.structuredContent.hostCatalog.models.length, 2);
    assert.equal(refreshed.result.structuredContent.hostCatalog.rateLimit.remainingPercent, 35);
    assert.deepEqual(refreshed.result.structuredContent.availableModels, ["gpt-5.6-luna"]);
    const opened = await client.request("tools/call", { name: "model_watch_update_settings", arguments: {
      scope: "global", patch: {
        evaluatorMode: "fixed-codex",
        evaluatorModel: "opencode-go/deepseek-v4-pro",
        candidateModels: ["gpt-5.6-luna", "opencode-go/deepseek-v4-pro"],
        externalModelThreshold: 40
      }
    } });
    assert.deepEqual(opened.result.structuredContent.availableModels, ["opencode-go/deepseek-v4-pro"]);
    assert.equal(opened.result.structuredContent.global.evaluatorModel, "opencode-go/deepseek-v4-pro");
    assert.deepEqual(opened.result.structuredContent.global.candidateModels, ["gpt-5.6-luna", "opencode-go/deepseek-v4-pro"]);
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
