import assert from "node:assert/strict";
import test from "node:test";
import { parseModelWatchCommand } from "../plugins/model-watch/src/commands.mjs";

test("parses enable and lifecycle commands", () => {
  assert.deepEqual(parseModelWatchCommand("$model-watch"), { action: "on", argument: null, remainder: "" });
  assert.deepEqual(parseModelWatchCommand("!model-watch on"), { action: "on", argument: null, remainder: "" });
  assert.equal(parseModelWatchCommand("!model-watch status").action, "status");
  assert.equal(parseModelWatchCommand("$model-watch pause（暂停哨兵评估）").action, "pause");
  assert.equal(parseModelWatchCommand("$model-watch resume").action, "resume");
  assert.equal(parseModelWatchCommand("$model-watch off").action, "off");
  assert.equal(parseModelWatchCommand("!model-watch test-card").action, "test-card");
  assert.deepEqual(parseModelWatchCommand("!model-watch test downgrade"), { action: "test", argument: null, remainder: "downgrade" });
});

test("parses inline check and preserves the task", () => {
  assert.deepEqual(
    parseModelWatchCommand("$model-watch check-inline（检查并执行），请继续登录方案"),
    { action: "check-inline", argument: null, remainder: "请继续登录方案" }
  );
});

test("removed commands are rejected", () => {
  for (const action of ["gate-next", "sync", "accept", "ignore", "correct"]) {
    assert.equal(parseModelWatchCommand(`$model-watch ${action}`).action, "unknown");
  }
});

test("ignores ordinary prompt", () => {
  assert.equal(parseModelWatchCommand("继续修改登录方案"), null);
});
