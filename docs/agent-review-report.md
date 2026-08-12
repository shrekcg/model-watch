# 模型哨兵 v1.1.0 独立审阅报告

- 审阅日期：2026-08-13
- 审阅基线：`main` 分支，提交 `e42df94`；功能版本 `v1.1.0`
- 审阅方式：只读代码/文档/测试审阅 + 运行自动测试（34/34 通过）
- 审阅范围：README、HANDOFF、MEMORY、docs/*、plugins/model-watch/*（hook/mcp/protocol/engine/state/commands/UI/Skill/配置）、tests/*、CI、marketplace 配置
- 审阅人结论：**没有 P0 问题；有 2 个 P1 风险（状态目录可能分裂、候选模型配置对用户不可见）；若干 P2 一致性与边界问题。主链路逻辑闭环成立。**

> 本文供接手 Agent 直接使用：第 7 节是问题清单（含证据、影响、修复建议、验证方式），第 8 节是建议的接手顺序。本报告为只读审阅产出，未修改任何项目文件（除本文件外）。

> **后续落实状态（2026-08-13）**：本报告基于 `e42df94` 的问题已在后续本地改动中落实。P1-1 已让 Hook 与 MCP 都以插件根目录解析状态目录，并补充入口契约测试；仍需真实桌面端验证实际宿主路径。P1-2 已在 README 写明静态候选集与 `MODEL_WATCH_AVAILABLE_MODELS` 的开发环境覆盖方式；动态读取宿主模型仍不在一期范围。P2-1 至 P2-8 已分别通过资料入库、暂停 `check-inline` 定义、控制命令正文提示、两行协议、上下文余量、单默认 Prompt、Hook 元数据和 `check` 无续跑票据处理。问题清单保留为审阅历史，不应再当作未修复待办。

---

## 1. 总体结论

**核心产品逻辑成立、契约自我约束严格、文档-代码-测试一致性高。**

主链路（按任务启用 → 同会话判断 → stay 静默执行 / change 暂停 → 用户手动选模型并原样重发 → 指纹命中直接执行）在代码层面是逻辑闭环的，失败路径全部安全放行，没有发现会卡死、串写主任务或泄露任务正文的硬伤。

必须先处理的两个 P1：

1. **Hook 与 MCP 的数据目录解析依赖不同的 cwd 假设**，真实宿主环境下可能读写不同目录 → 状态静默分裂、整个产品失效且无提示。
2. **默认候选模型（`gpt-5.6-luna/terra/sol`）与实际宿主模型解耦，且 README 未告知 `MODEL_WATCH_AVAILABLE_MODELS` 配置方法** → 开箱即用时 change 路径可能永远失败，或推荐宿主根本不存在的模型。

---

## 2. 产品逻辑核验（对照产品契约）

以下契约项全部验证通过：

| 契约 | 代码证据 | 结论 |
| --- | --- | --- |
| 默认不监测，`!model-watch on` 按任务启用 | `plugins/model-watch/scripts/model-watch-hook.mjs:101`；`:106` 未启用且无命令直接放行、不写状态 | ✅ |
| 选中菜单 ≠ 启用，只有 Hook 控制回执可确认 | `plugins/model-watch/src/protocol.mjs:68`；`plugins/model-watch/skills/model-watch/SKILL.md:25` | ✅ |
| 启用命令本身不评估 | `protocol.mjs:66-75` 控制分支"本轮不运行推荐引擎" | ✅ |
| stay 内部完成、无任何展示 | `protocol.mjs:58` | ✅（依赖模型遵守，属已知边界） |
| change 只展示建议、不执行主任务 | `protocol.mjs:63`；`plugins/model-watch/src/engine.mjs:18-24` | ✅ |
| 重发同一请求直接执行、不重复判断 | `hook.mjs:138-150` routeMatched → ROUTE 上下文 | ✅ |
| uncertain/failed/未知模型/推荐同模型 → 一律失败放行 | `engine.mjs:18-24`；`plugins/model-watch/src/state.mjs:272-284`；`hook.mjs:191-194` | ✅ |
| 不保存正文/附件，仅 SHA-256 + 模型元数据 | `plugins/model-watch/src/engine.mjs:5-7`；`tests/state.test.mjs:52-61` | ✅ |
| 多任务并发不串写 | 每任务独立文件 + 精确 sessionId + token+PID 文件锁 | ✅ |

### 2.1 走查过且确认安全的分支

- change 后用户发 `off`：先记 superseded 再清 ticket（`hook.mjs:110-113` + `:102`），无脏 ticket 残留；
- ticket 15 分钟过期后重发：`state.mjs:275` 归一化时已置 null，重新评估而非误放行；
- 模型推荐与当前模型相同 / 当前模型未知：一律转 failed，不建 ticket（`plugins/model-watch/scripts/model-watch-mcp.mjs:85-92`）；
- 并发锁 5 秒等待超时抛错 → hook 顶层 catch 放行（`hook.mjs:191-194`），不会阻断主任务；
- `check-inline` 只哈希 remainder（主任务部分，`hook.mjs:108`），重发完整命令仍能命中同一 ticket，闭环成立。

### 2.2 闭环的小缺口（P2）

1. **paused 状态下的 `check-inline` 无协议可循**：`hook.mjs:152-154` paused 分支只注入状态标识指令。模型收到 `!model-watch check-inline，X` 时没有判断协议，是否执行 X 行为未定义。
2. **`!model-watch on 后跟正文` 正文被静默丢弃**：`plugins/model-watch/src/commands.mjs:21` 解析出 remainder，但 on/off/pause/resume 走控制分支不执行它；同时 `protocol.mjs:13` 会把 remainder 显示为"主任务正文"，可能诱导模型误执行。
3. **change 后重发 `!model-watch check`**：routeMatched 时 ROUTE 上下文（`protocol.mjs:22`）说"直接完整执行本轮原始用户请求"，但原始请求是 check 命令本身，语义含糊（无实际危害）。

---

## 3. 决策明确性

**明确，是项目最强的一面**：

- 范围决策有完整决策链：`docs/product-decisions.md` 记录"上一轮预测下一轮 → 本轮输入前移判断"、"三评估器 → 一期只留同会话"的全部演进与理由；
- "不做"清单清晰（`docs/agent-review-guide.md` 2.2、`HANDOFF.md:40-46`），且代码与文档高度一致（`tests/mcp.test.mjs:122-126` 断言 UI 不出现"内部子 Agent / 外部 API / 推理深度 / gate-next"）；
- 历史废弃内容有标注（MEMORY.md 中"三种评估器已实现"属旧记录，`HANDOFF.md` 与 guide 已声明以其为准）。

遗留的决策模糊点（P2）：

- **`docs/agent-review-guide.md` 本身是 untracked 文件**（`git status` 显示 `??`），且 `.gitignore` 排除了 `MEMORY.md` 与 `docs/product-decisions.md`，而 guide 引用了 MEMORY.md——新 clone 的审阅者会扑空。建议 guide 入库，或删除对 MEMORY 的引用。
- `protocol.mjs:63` change 输出格式用分号（"只输出两行：模型建议：切换至 <模型>；原因：…"），看起来像一行两段；`SKILL.md:67` 示例是标准两行。建议统一为明确换行格式。

---

## 4. 技术细节亮点（接手时可复用）

- 状态层：原子写（`state.mjs:90-95`）、token+PID 文件锁、释放时核对 token（`state.mjs:116-124`）、死 owner 回收（`state.mjs:127-132`）、sessionId 清洗防路径穿越（`state.mjs:54-57`）、schema 归一化兜底；
- 校验链：change 三重校验（候选合法、当前模型已知、非同一模型）在 MCP 服务端强制（`mcp.mjs:76-101`），不信任模型传参；evaluator 服务端写死 `same-session`；
- 精确会话：UI 无 sessionId 时只允许全局设置（`mcp.mjs:64-66`），禁止回退"最近任务"；
- 协议与引擎分离：ENGINE_VERSION 2.0.0 独立版本化（`engine.mjs:3`）。

---

## 5. 测试与验证现状

- `npm test` 实测 **34/34 通过**；`git diff --check` 通过；全部 `.mjs` 语法检查通过；
- 测试质量高：行为断言而非实现复读（`tests/workflow.test.mjs` 完整走通"启用→评估→change→重发→adopted"端到端链路；`tests/repository.test.mjs` 锁定 README/UI 文案契约）；
- **自动测试盲区（与 P1-1 直接相关）**：所有测试都显式传 `MODEL_WATCH_DATA_DIR`，没有覆盖"未配置 env 时 Hook 与 MCP 数据目录是否一致"的真实宿主场景。

---

## 6. 已知外部依赖（产品边界，非缺陷）

1. 模型是否遵守协议无法强制（逻辑拦截，非硬阻断）——README:34 已声明；
2. "原样重发"依赖用户手动操作，附件重发取决于 Codex 桌面端——README:122 已声明；
3. 真实桌面端 8 项复验尚未完成（`docs/agent-review-guide.md:208-219`）。

---

## 7. 问题清单（P0/P1/P2）

### P1-1：Hook 与 MCP 的数据目录解析依赖不同 cwd，状态可能静默分裂

- **证据**：`plugins/model-watch/src/state.mjs:28-52`（`inferPluginDataDir` / `resolveDataDir`）；`plugins/model-watch/hooks/hooks.json:10,23`（`node ${PLUGIN_ROOT}/scripts/model-watch-hook.mjs`）；`plugins/model-watch/.mcp.json:4-6`（`cwd: "."`）
- **机制**：
  - MCP 以插件缓存目录为 cwd 启动 → `inferPluginDataDir` 命中 `.../plugins/cache/<m>/<p>/<v>` → 数据目录为 `.../plugins/data/<m>-<p>`；
  - Hook 由宿主以 `node ${PLUGIN_ROOT}/...` 启动，其 `process.cwd()` 取决于宿主（可能是用户项目目录）。若不是插件缓存目录结构，则回退 `~/.codex/model-watch`；
  - 两个进程解析出**不同数据目录**时：Hook 写入的 enabled/ticket 与 MCP/UI 读到的状态完全分裂，插件静默失效，无任何日志提示。
- **影响**：真实桌面端一旦发生，整个产品不可用且难以排查。
- **复现**：真实 Codex 桌面端安装后，检查 Hook 进程与 MCP 进程实际写/读的数据目录是否一致（当前手测用例未覆盖此检查）。
- **最小修复建议**：Hook 侧显式优先用 `PLUGIN_ROOT`（或输入中的插件根路径）按与 MCP 相同的规则推导数据目录；或在 hooks.json 中为两个 hook 显式注入同一个 `MODEL_WATCH_DATA_DIR`。
- **验证方式**：新增自动测试——模拟 Hook 以非 cache cwd 启动、MCP 以 cache cwd 启动，断言两者解析到同一数据目录（当前实现预期会失败，正好暴露问题）；桌面端复验加一项"两个进程数据目录一致"。

### P1-2：默认候选模型与宿主解耦，且配置方法对用户不可见

- **证据**：`plugins/model-watch/scripts/model-watch-hook.mjs:19,44-50`；`plugins/model-watch/scripts/model-watch-mcp.mjs:25-31`（`MODEL_WATCH_AVAILABLE_MODELS`，默认 `gpt-5.6-luna/terra/sol`）；README 全文无该环境变量说明（仅 `docs/agent-review-guide.md:176` 提及）
- **影响**：若宿主真实模型名不在候选集——模型推荐任意真实模型都会被 `engine.mjs:19` 拒绝 → change 永远转 failed；若模型推荐候选集中的虚构模型，用户无法在宿主中选择它 → change 路径开箱不可用。
- **复现**：安装插件、启用后触发一次判断即可验证（取决于模型行为）。
- **最小修复建议**：README 增加"候选模型配置"小节（env 名称、示例、说明静态列表只是判断约束）；二期可考虑从宿主动态读取模型列表。
- **验证方式**：README 全文 grep `MODEL_WATCH_AVAILABLE_MODELS`；桌面端触发一次 change。

### P2 清单

| # | 问题 | 证据 | 修复建议 |
| --- | --- | --- | --- |
| P2-1 | `docs/agent-review-guide.md` untracked 未入库；guide 引用 gitignored 的 MEMORY.md，新 clone 审阅者扑空 | `git status`；`.gitignore:10-11` | guide 入库；去掉对 MEMORY 的引用或注明"本地文件" |
| P2-2 | paused 时 `check-inline` 无协议可循，行为未定义 | `hook.mjs:152-154` | paused 分支对 check-inline 注入"直接执行逗号后主任务"的简短指令 |
| P2-3 | `!model-watch on 后跟正文` 正文被静默丢弃，且协议把 remainder 显示为"主任务正文" | `commands.mjs:21`；`protocol.mjs:13` | 控制命令带 remainder 时协议明确"忽略正文"；或文档禁止该写法 |
| P2-4 | change 输出格式分号 vs 两行不一致 | `protocol.mjs:63` vs `SKILL.md:67` | 统一为明确换行 |
| P2-5 | `additionalContextLimit: 1600` 对协议实测 987 字符，余量约 60%，协议增长有截断风险 | `hooks.json:25` | 增加协议长度回归断言或提高 limit |
| P2-6 | `plugin.json:32-35` defaultPrompt 两条（on + settings）vs `agents/openai.yaml:5` 一条，从 `/` 菜单选择可能注入两行 | `plugins/model-watch/.codex-plugin/plugin.json`；`agents/openai.yaml` | 统一为单条 `!model-watch on` |
| P2-7 | `hooks.json:2` 描述仍为英文 "recommendation gate"，与真实语义（同会话逻辑门）不符 | `hooks.json:2` | 改为中文准确描述（guide:234 已自我标注） |
| P2-8 | change 后重发 `!model-watch check` 的 ROUTE 语义含糊 | `protocol.mjs:22` | 或在协议中说明 check 重发的预期行为 |

---

## 8. 建议的接手顺序（供接手 Agent）

1. 先读：`README.md`、`docs/agent-review-guide.md`、`docs/agent-review-report.md`（本文）、`HANDOFF.md`、`docs/manual-test-cases.md`。
2. **先修 P1-1（数据目录分裂）**：统一 Hook 与 MCP 的数据目录解析；补自动测试（Hook 非 cache cwd vs MCP cache cwd 解析一致）；把"两个进程数据目录一致"加入手测清单。
3. **再修 P1-2（候选模型配置不可见）**：README 补配置小节；确认默认候选集与实际宿主模型的关系。
4. 处理 P2 清单（按 P2-1 → P2-6 → 其余顺序，均为低风险小改动）。
5. 跑 `npm ci`、`npm ci --prefix plugins/model-watch`、`npm test`、`git diff --check`；改动插件后 `npm run update:plugin -- --no-refresh` 并重启 Codex 确认 Hook 信任。
6. 按 `docs/manual-test-cases.md` 做桌面端复验，重点新增项：Hook/MCP 数据目录一致性、候选模型可用性。
7. 遵守变更纪律（guide 第 12 节）：不动用 `git reset --hard` / `git checkout -- .`；产品逻辑改动须同步 README、SVG、Skill、Hook、MCP、UI、手测与自动测试。

## 9. 附注

- 本次审阅未修改任何项目文件（除本报告外）；`docs/agent-review-guide.md` 本身仍是 untracked 状态。
- 本报告与 `docs/agent-review-guide.md` 配套使用：guide 是"项目事实与审阅任务入口"，本报告是"本次审阅结论与待办清单"。
