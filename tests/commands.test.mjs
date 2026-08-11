import assert from "node:assert/strict";
import test from "node:test";
import { parseModelWatchCommand } from "../plugins/model-watch/src/commands.mjs";

test("parses bare enable command", () => {
  assert.deepEqual(parseModelWatchCommand("$model-watch"), {
    action: "on",
    argument: null,
    remainder: ""
  });
});

test("parses Chinese command label and inline task", () => {
  assert.deepEqual(
    parseModelWatchCommand("$model-watch check-inline（并行检查），请继续登录方案"),
    { action: "check-inline", argument: null, remainder: "请继续登录方案" }
  );
});

test("parses gate command and keeps task text", () => {
  const parsed = parseModelWatchCommand("$model-watch gate-next，请继续修改刚才的登录方案。");
  assert.equal(parsed.action, "gate-next");
  assert.equal(parsed.remainder, "请继续修改刚才的登录方案。");
});

test("parses effort sync", () => {
  assert.deepEqual(parseModelWatchCommand("$model-watch sync high"), {
    action: "sync",
    argument: "high",
    remainder: ""
  });
});

test("ignores ordinary prompt", () => {
  assert.equal(parseModelWatchCommand("继续修改登录方案"), null);
});
