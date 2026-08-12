# 模型哨兵交接说明（v1.1.0）

更新时间：2026-08-13

## 当前基线

- 仓库：`https://github.com/shrekcg/model-watch`
- 发布分支：`agent/model-watch-1.0.3-update`
- 发布版本：`v1.1.0`
- 一期评估器：当前主 Agent 的同会话模型；不启动子 Agent，不调用外部评估服务。

## 已交付的工作流

1. 用户在目标任务发送 `!model-watch on`；仅启用当前任务。
2. 下一条真实请求到达后，`UserPromptSubmit` Hook 注入任务配置、当前模型、候选模型与判断协议。
3. 当前主 Agent 先判断并通过 MCP 保存 `stay`、`change`、`uncertain` 或 `failed`。
4. `stay`、不确定、失败或保存失败时直接完成主任务；可在末尾显示 `🛰️`。
5. `change` 时模型只显示建议与理由，不执行主任务。
6. 用户在 Codex 原生选择器中切换、保持或选择其他模型，原样重新发送同一请求；指纹命中后直接执行，并记录实际结果。

这是一条同会话逻辑拦截，不是模型调用前硬阻断：请求已交给当前主模型，因此会消耗一次判断成本；如果模型不遵守协议，插件无法撤销已开始的主任务。

## 关键实现与保护

- `plugins/model-watch/scripts/model-watch-hook.mjs`：会话和模型采集、请求匹配、协议注入。
- `plugins/model-watch/scripts/model-watch-mcp.mjs`：基于官方 `@modelcontextprotocol/sdk` 的 MCP 工具与设置 UI。
- `plugins/model-watch/src/state.mjs`：schema 迁移、TTL、观察记录、原子写入和 PID + token 文件锁。
- 所有任务级读写要求精确 `sessionId`，禁止回退到最近任务，避免多会话串写。
- 本地状态仅存 SHA-256 指纹与模型元数据；不存正文和附件，不能用它们恢复原始请求。

## 已验证

```text
npm test          34 passed, 0 failed
git diff --check  passed
```

自动测试验证命令解析、协议、状态迁移、精确会话隔离、锁、MCP SDK、设置同步、同一请求续跑与模型观察。真实桌面端仍需按 `docs/manual-test-cases.md` 验证 Hook 信任、热加载、模型身份采集以及附件重发体验。

## 明确未做

- 子 Agent / 外部 API 评估器和对应设置；
- 自动切模型、推理深度选择；
- 建议卡片中的“继续原请求”按钮与无损附件重放；
- 从宿主动态获取候选模型；
- 评估准确率或切换阈值的产品校准。

后续若扩展评估器，必须先定义独立的成本、超时、失败放行、数据边界与会话一致性契约，不能改变 v1.1.0 主路径的按需启用和人工选择权。

## 接手检查清单

1. 阅读 `README.md`、`MEMORY.md`、`docs/manual-test-cases.md` 和本文件。
2. 不要执行 `git reset --hard` 或覆盖工作区；先检查 `git status --short --branch`。
3. 运行 `npm ci`、`npm ci --prefix plugins/model-watch`、`npm test`、`git diff --check`。
4. 改动插件后运行 `npm run update:plugin -- --no-refresh`，重启 Codex 并重新确认 Hook 信任。
5. 任何“已启用”的用户提示必须以实际控制回执 `[MODEL_WATCH_CONTROL enabled: true]` 或状态工具结果为准，不能只因用户选中了插件就口头确认。
