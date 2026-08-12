import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readmePath = resolve(root, "README.md");
const readme = readFileSync(readmePath, "utf8");

test("required repository files exist", () => {
  const requiredFiles = [
    "README.md",
    "CONTRIBUTING.md",
    "HANDOFF.md",
    "docs/agent-review-guide.md",
    "docs/agent-review-report.md",
    "docs/manual-test-cases.md",
    "LICENSE",
    "package.json",
    ".github/workflows/validate.yml",
    ".agents/plugins/marketplace.json",
    "plugins/model-watch/.codex-plugin/plugin.json",
    "plugins/model-watch/.mcp.json",
    "plugins/model-watch/package.json",
    "plugins/model-watch/package-lock.json",
    "plugins/model-watch/hooks/hooks.json",
    "plugins/model-watch/skills/model-watch/SKILL.md",
    "plugins/model-watch/skills/model-watch/agents/openai.yaml",
    "plugins/model-watch/scripts/model-watch-hook.mjs",
    "plugins/model-watch/scripts/model-watch-mcp.mjs",
    "scripts/update-plugin.mjs",
    "plugins/model-watch/ui/settings.html"
  ];

  for (const file of requiredFiles) {
    assert.equal(existsSync(resolve(root, file)), true, `Missing ${file}`);
  }
});

test("plugin manifest points to real bundled capabilities", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "plugins/model-watch/.codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "model-watch");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(existsSync(resolve(root, "plugins/model-watch/skills/model-watch/SKILL.md")), true);
  assert.equal(existsSync(resolve(root, "plugins/model-watch/hooks/hooks.json")), true);
});

test("plugin menu uses a hook-recognized command that does not trigger plugin autocomplete", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "plugins/model-watch/.codex-plugin/plugin.json"), "utf8"));
  const agent = readFileSync(resolve(root, "plugins/model-watch/skills/model-watch/agents/openai.yaml"), "utf8");
  assert.deepEqual(manifest.interface.defaultPrompt, ["!model-watch on"]);
  assert.match(agent, /^\s*default_prompt:\s*"!model-watch on"\s*$/m);
});

test("README documents existing-task limitations and fork fallback", () => {
  assert.match(readme, /老任务/);
  assert.match(readme, /\$model-watch/);
  assert.match(readme, /Fork/i);
});

test("README explains first-use invocation and hook trust", () => {
  assert.match(readme, /安装与首次启用/);
  assert.match(readme, /!model-watch on/);
  assert.match(readme, /\/` 菜单/);
  assert.match(readme, /\/hooks/);
  assert.match(readme, /UserPromptSubmit/);
});

test("settings describes an internal-only stay decision and the bang command", () => {
  const settings = readFileSync(resolve(root, "plugins/model-watch/ui/settings.html"), "utf8");
  assert.match(settings, /!model-watch on/);
  assert.match(settings, /内部判断（不展示）/);
  assert.match(settings, /保持当前模型时只显示任务结果/);
});

test("README documents same-session evaluation and privacy boundaries", () => {
  assert.match(readme, /下一条真实请求/);
  assert.match(readme, /同会话逻辑拦截/);
  assert.match(readme, /逻辑拦截/);
  assert.match(readme, /重新发送同一请求/);
  assert.match(readme, /不保存任务正文/);
  assert.match(readme, /子 Agent 评估器、外部评估服务/);
  assert.match(readme, /推理深度切换/);
  assert.doesNotMatch(readme, /model-watch gate-next/);
});

test("README documents the non-destructive plugin update path", () => {
  assert.match(readme, /npm run update:plugin/);
  assert.match(readme, /npm ci --prefix plugins\/model-watch/);
  assert.match(readme, /codex plugin add model-watch@model-watch/);
});

test("README documents the static candidate-model boundary", () => {
  assert.match(readme, /MODEL_WATCH_AVAILABLE_MODELS/);
  assert.match(readme, /gpt-5\.6-luna/);
  assert.match(readme, /不是 Codex 宿主动态返回的模型列表/);
});

test("hook metadata and both runtime entrypoints share the plugin-root data contract", () => {
  const hooks = JSON.parse(readFileSync(resolve(root, "plugins/model-watch/hooks/hooks.json"), "utf8"));
  const userPromptHook = hooks.hooks.UserPromptSubmit[0].hooks[0];
  const hookScript = readFileSync(resolve(root, "plugins/model-watch/scripts/model-watch-hook.mjs"), "utf8");
  const mcpScript = readFileSync(resolve(root, "plugins/model-watch/scripts/model-watch-mcp.mjs"), "utf8");
  assert.match(hooks.description, /同会话模型判断协议/);
  assert.ok(userPromptHook.additionalContextLimit >= 2400);
  assert.match(hookScript, /resolveDataDir\(process\.env, PLUGIN_ROOT\)/);
  assert.match(mcpScript, /resolveDataDir\(process\.env, ROOT\)/);
});

test("README local image references resolve", () => {
  const imagePattern = /<img[^>]+src="(\.\/[^"#?]+)"/g;
  const images = [...readme.matchAll(imagePattern)].map((match) => match[1]);

  assert.ok(images.length > 0, "README should reference at least one local image");

  for (const image of images) {
    assert.equal(existsSync(resolve(root, image)), true, `Missing README image ${image}`);
  }
});

test("README SVG assets include accessible metadata", () => {
  const svgPattern = /<img[^>]+src="(\.\/[^"#?]+\.svg)"/g;
  const svgPaths = [...readme.matchAll(svgPattern)].map((match) => match[1]);

  for (const svgPath of svgPaths) {
    const svg = readFileSync(resolve(root, svgPath), "utf8");
    assert.match(svg, /viewBox="0 0 1200 \d+"/);
    assert.match(svg, /<title[^>]*>.+<\/title>/s);
    assert.match(svg, /<desc[^>]*>.+<\/desc>/s);
  }
});

test("README excludes internal release-state language", () => {
  const forbiddenPhrases = [
    "当前仓库处于开发准备阶段",
    "README 用于确认产品方案",
    "发布前确认",
    "首个可运行版本会补充"
  ];

  for (const phrase of forbiddenPhrases) {
    assert.equal(readme.includes(phrase), false, `README contains internal phrase: ${phrase}`);
  }
});
