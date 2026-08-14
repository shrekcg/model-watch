# 模型哨兵交接说明（v1.1.1）

更新时间：2026-08-13

## 当前基线

- 仓库：`https://github.com/shrekcg/model-watch`
- 稳定分支：`main`
- 发布版本：`v1.1.1`
- 默认评估器：当前主 Agent 的同会话模型。另有未发布的实验性固定 Codex 评估器，默认 GPT-5.6 Terra，可选 Luna/Terra/Sol；不启动子 Agent，不调用外部评估服务。

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
- `plugins/model-watch/src/state.mjs`：schema v8 迁移、TTL、最近 12 条可关联评估/观察记录、动态宿主目录快照、原子写入和 PID + token 文件锁；Hook 与 MCP 都以插件根目录推导同一数据目录。
- 所有任务级读写要求精确 `sessionId`，禁止回退到最近任务，避免多会话串写。
- 每条评估必须绑定 Hook 的精确 `turnId`，迟到结果会被拒绝；观察记录通过评估 ID 关联采纳、保持、超时、替代或关闭。
- 本地状态仅存 SHA-256 指纹与模型元数据；不存正文和附件，不能用它们恢复原始请求。

## 已验证

自动测试基线会随本地改动递增；提交前运行 `npm test` 与 `git diff --check`，不要引用过期的固定通过数量。

自动测试验证命令解析、协议、状态迁移、精确会话隔离、锁、MCP SDK、设置同步、同一请求续跑与模型观察。真实桌面端仍需按 `docs/manual-test-cases.md` 验证 Hook 信任、热加载、模型身份采集以及附件重发体验。

## 明确未做

- 子 Agent / 外部 API 评估器和对应设置；
- 自动切模型、推理深度选择；
- 建议卡片中的“继续原请求”按钮与无损附件重放；
- 评估准确率或切换阈值的产品校准。
- 附件指纹、字节级重放或跨会话上下文无损保证；这些依赖宿主能力，必须桌面端实测。

## 下一版本地 PoC：建议卡片与单击续跑

用户已提出在 `change` 后显示独立建议卡片，并通过“我已知晓/忽略建议”按钮继续上一条主任务，免去手动输入或原样重发。该能力已经形成未提交、未发布的本地 PoC。

设计时必须坚持：按钮只记录显式意图，真实模型结果仍由续跑轮 Hook 观察；用户若要换模型，需要先使用 Codex 原生选择器，再点击继续。卡片续跑必须使用一次性 gate、幂等键和 opaque nonce，并与手动原样重发共享同一个原子消费点，防止双重执行。不得保存或在 envelope 中携带原始请求正文和附件。

PoC 已包含 recommendation MCP App、`model_watch_present_recommendation`、幂等 `model_watch_prepare_resume`、一次性 gate/nonce、卡片恢复 envelope、重放拒绝和显式选择/实际模型分离记录。状态 schema 升级为 v5；自动测试 47/47 通过，缓存版已本地覆盖安装。恢复 envelope 不包含任务正文或附件。

最大阻断仍是宿主能力而非卡片 HTML：系统禁止代理自动操作当前 Codex 应用，也禁止隔离浏览器执行本地卡片代码，因此最后一步必须由用户在新任务亲自点击。需验证 MCP App follow-up 能否进入当前任务、触发 `UserPromptSubmit`、使用刚选择的模型，并让主 Agent可靠读取上一条请求及附件。验证前不得把它写成“一键无损恢复”；若能力不可用，只能降级为按钮记录意图后提示用户原样重发。详细决策见 `MEMORY.md` 与 `docs/product-decisions.md`。

## 本地待验收：确定性测试、推荐策略与固定评估器

- 新增 `!model-watch test-card`，不依赖模型是否自然判定 change；它创建测试专用建议卡，恢复后只输出 `MODEL_WATCH_TEST_PASS`、实际模型与用户操作。测试历史与真实推荐历史隔离。
- 推荐策略为 `MODEL_WATCH_POLICY 3.0.0`，采用最低充分模型和反事实风险比较，保存 confidence/signals/decisionBasis；不做固定任务路由或阈值。
- schema v7 增加固定评估器遥测：每条评估保存实际/请求评估模型、上下文覆盖、起止时间、耗时、回退原因及成本元数据；状态仍不保存正文或附件。设置页“评估记录”可查看当前任务最近 12 条真实/测试评估和实际模型选择。
- fixed-codex 是显式实验模式，默认 Terra；仅传入本轮原文，20 秒失败/超时回退 same-session，使用 `MODEL_WATCH_BYPASS=1` 防递归。失败本身会留下 `fixed-codex / failed` 记录，随后同会话回退另留一条记录，避免误报。
- API 等价成本只在固定评估成功时按公开 API 单价、可见输入和 350 输出 token 粗估；它不是订阅账单，也不包括隐藏推理、缓存或工具调用。同会话/失败为不可归因，不显示金额。
- 完成前必须实测：测试卡是否展示且仅续跑一次；设置页 Terra 默认和 Luna/Terra/Sol 选项；记录页的真实/测试/实际选择与成本显示；fixed-codex 是否可调用、耗时、失败回退；不能宣称固定评估器具备全历史或附件上下文。

后续若扩展评估器，必须先定义独立的成本、超时、失败放行、数据边界与会话一致性契约，不能改变 v1.1.1 主路径的按需启用和人工选择权。

## 当前运行状态与下一轮产品决策（2026-08-13）

- 已将 `autoEnableNewTasks` 关闭，并停用本地已存在的全部 25 个任务（包括个人网站任务和本对话）。产品默认是“新任务关闭；用户在指定任务发送 `!model-watch on` 后才监控”。不要在后续实现中恢复全局自动启用作为默认值。
- 固定评估器仍为实验，不应作为默认：实测嵌套 `codex exec` 有 `os error 2`、约 15 秒超时/失败的情况。个人网站普通同会话记录只有毫秒级工具耗时；长时主要来自浏览器、图片、构建与实现。固定评估失败必须记录失败与同会话回退两条，而非混淆实际模型。
- 当前本地缓存应更新为 settings-v8；旧任务的 MCP 进程可能继续运行旧 schema，重启 Codex 或新建任务才可验证新版 UI。
- 动态目录桥接现已实现：用户在设置页主动刷新时，以短生命周期 app-server 读取 `model/list` 和 `account/rateLimits/read`；Hook 不执行这类进程。目录快照有效 1 小时；默认只推 GPT，`codex` 限额桶低于可配置阈值（默认 30%）才开放外部候选。该桶不是单模型 GPT 余额，不能用于订阅账单或逐模型额度承诺。

## 本地实现更新：通用双向候选与测试夹具（未发布）

- 推荐协议已明确“最低充分模型”是任意候选间的模型原生比较：可升级、可降级、可保持，不引入任务类型路由、固定评分或硬阈值。记录的 `changeDirection` 只服务于回溯；对无法可靠相对排序的外部模型为 `unknown`。
- 内部夹具文档为 `docs/testing-fixtures.md`；通过 `!model-watch test <case>` 使用。已实现/测试 `card`、`upgrade`、`downgrade`、`stay`、`uncertain`、`fixed-fallback`、`unknown-model` 等。夹具记录与真实历史隔离。
- app-server daemon 控制 socket 虽不存在，但独立 `codex app-server --stdio` 已在本机认证下成功返回模型目录与 `codex` 限额桶；这被限定为用户主动触发的只读刷新，不在 Hook 内运行。仍需真实桌面验证刷新 UI、缓存热加载和外部候选建议。
- 本轮改动尚待完整回归、未提交、未发布、未更新本机插件缓存。

## 2026-08-14 设置语义更新（未提交）

- 设置页将评估器与候选/额度合并：用户可见只有“跟随主模型（默认）”和“自定义评估模型”。后者从刷新后的目录选择一个模型；内部 `fixed-codex` 仅为兼容实现名。
- 配置 schema v9 新增 `candidateModels`。用户选择的候选会被 GPT 优先策略分成 GPT 池和第三方池：额度高于用户自定义阈值时仅 GPT，达到/低于阈值时仅第三方；空池才安全回退另一池。阈值是 0–100 的任意整数。
- UI 已移除测试指令与“查看测试指令”按钮；内部测试命令与 `docs/testing-fixtures.md` 保留。后续验证时优先检查设置页目录刷新、候选勾选、自定义评估下拉和两个候选池切换。

## 接手检查清单

1. 阅读 `README.md`、`docs/agent-review-guide.md`、`docs/agent-review-report.md`、`MEMORY.md`、`docs/manual-test-cases.md` 和本文件。
2. 不要执行 `git reset --hard` 或覆盖工作区；先检查 `git status --short --branch`。
3. 运行 `npm ci`、`npm ci --prefix plugins/model-watch`、`npm test`、`git diff --check`。
4. 改动插件后运行 `npm run update:plugin -- --no-refresh`，重启 Codex 并重新确认 Hook 信任。
5. 任何“已启用”的用户提示必须以实际控制回执 `[MODEL_WATCH_CONTROL enabled: true]` 或状态工具结果为准，不能只因用户选中了插件就口头确认。
