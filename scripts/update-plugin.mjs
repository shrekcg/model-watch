#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const marketplace = process.env.MODEL_WATCH_MARKETPLACE || "model-watch";
const plugin = process.env.MODEL_WATCH_PLUGIN || "model-watch";
const selector = `${plugin}@${marketplace}`;
const skipRefresh = process.argv.includes("--no-refresh");

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) {
    if (allowFailure) return false;
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result.status === 0;
}

console.log(`更新 ${selector}…`);

// MCP runtime dependencies are intentionally not checked into Git. Install the
// plugin-local runtime before asking Codex to copy the plugin into its cache.
run("npm", ["ci", "--prefix", "plugins/model-watch"]);

if (!skipRefresh) {
  const refreshed = run("codex", ["plugin", "marketplace", "upgrade", marketplace], { allowFailure: true });
  if (!refreshed) {
    console.warn(`提示：无法刷新 Git Marketplace「${marketplace}」，继续使用当前已配置的 Marketplace。`);
  }
}

run("codex", ["plugin", "add", selector]);
console.log("更新完成。重新打开任务或重启 Codex 后即可使用新版本。 ");
