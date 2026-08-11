import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const serverPath = resolve(import.meta.dirname, "../plugins/model-watch/scripts/model-watch-mcp.mjs");

function createClient(dataDir) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, MODEL_WATCH_DATA_DIR: dataDir },
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

test("MCP server exposes settings UI and persists task configuration", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "model-watch-mcp-"));
  const client = createClient(dataDir);
  try {
    const initialized = await client.request("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(initialized.result.serverInfo.name, "model-watch");

    const listed = await client.request("tools/list");
    assert.ok(listed.result.tools.some((tool) => tool.name === "model_watch_open_settings"));

    const resource = await client.request("resources/read", { uri: "ui://model-watch/settings-v1.html" });
    assert.match(resource.result.contents[0].text, /模型哨兵设置/);

    const updated = await client.request("tools/call", {
      name: "model_watch_update_settings",
      arguments: {
        scope: "task",
        sessionId: "mcp-task",
        patch: { enabled: true, currentEffort: "high" }
      }
    });
    assert.equal(updated.result.structuredContent.task.enabled, true);
    assert.equal(updated.result.structuredContent.task.currentEffort, "high");
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
