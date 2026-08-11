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
    "LICENSE",
    "package.json",
    ".github/workflows/validate.yml"
  ];

  for (const file of requiredFiles) {
    assert.equal(existsSync(resolve(root, file)), true, `Missing ${file}`);
  }
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
