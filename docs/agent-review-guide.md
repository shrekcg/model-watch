# 模型哨兵：面向审阅 Agent 的项目说明

更新时间：2026-08-13  
当前公开基线：`main` 分支，提交 `e42df94`（README 视觉说明更新）；功能基线 `v1.1.0`。

> 本文用于让后续 Agent 快速、准确地理解并审阅项目。它是“事实、边界、风险和审阅任务”的统一入口；产品宣传以 `README.md` 为准，历史决策以 `MEMORY.md` 为参考，但历史记录可能包含已废弃方案。

`docs/agent-review-report.md` 是一次独立审阅的快照；其中的 P1/P2 修复状态以报告开头的“后续落实状态”及当前源码为准。

## 1. 一句话定义

模型哨兵是一个 Codex 插件：用户按任务启用后，当前主 Agent 在每条真实请求开始时先完成一次同会话模型适配判断；模型合适时直接完成主任务，切换收益明确时暂停主任务、展示建议，用户在 Codex 原生界面选择模型后原样重发请求以继续。

它是**人工决策辅助**，不是自动路由器或独立评估平台。

## 2. 审阅时必须守住的产品契约

### 2.1 当前一期必须成立

1. 默认不监测所有任务；用户可通过 `!model-watch on` 仅启用当前任务。
2. 选中 `/` 菜单中的插件或看到 Skill 标签，**不等于**任务已经启用；只有 Hook 写入并注入 `[MODEL_WATCH_CONTROL ... enabled: true]`，才可确认启用。
3. 启用命令本身不评估；下一条真实请求才进入判断。
4. `stay`：内部完成判断并保存，用户只获得正常主任务结果；不展示 `stay`、分析过程或“正在判断”。
5. `change`：只展示“建议模型 + 简短理由”，**不执行**本轮主任务。
6. 用户手动切换、保持或选择其他模型后，原样重发同一请求；插件识别后直接执行，且不重复判断。
7. `uncertain`、`failed`、保存失败、模型身份未知或推荐模型与当前模型相同：一律失败放行，直接执行主任务。
8. 状态不保存任务正文或附件；仅保存请求 SHA-256、模型元数据和必要状态。
9. 多任务并发时，一个任务的设置或判断不得写入另一个任务。

### 2.2 当前一期明确不做

- 子 Agent 或外部 API 评估器；
- 自动切换模型、自动恢复任务、一键“继续”；
- 推理深度建议或切换；
- 从宿主动态读取候选模型；
- 任务正文、附件、完整历史的持久化或重放；
- 宣称模型调用前的硬拦截、零成本、零失真或准确率承诺。

## 3. 用户可见流程

```text
用户：!model-watch on
  → Hook 将该 session 写为 enabled；模型只确认启用

用户：第一条真实任务
  → Hook 注入当前模型、候选模型和判断协议
  → 当前主 Agent 内部判断并调用 MCP 保存结果
  → stay / uncertain / failed：直接执行主任务
  → change：只显示建议，不执行主任务

用户：在 Codex 原生选择器中选择任意模型，再原样重发 change 的请求
  → Hook 比对请求指纹，消费 route ticket
  → 记录 adopted / kept / other
  → 注入 ROUTE 上下文，主 Agent 直接执行，不再判断
```

### 3.1 “首轮”“每轮”和成本

- 手动启用后，下一条真实请求就会评估；它不一定要先完成一轮任务才可能提出建议。
- README 用“第一轮通常建立上下文、后续轮更可能体现切换价值”解释典型体验，不能把这表述成代码前置条件。
- 启用后每条真实请求都会令当前主模型参与一次判断，因此按任务开关是成本控制手段。

### 3.2 可见 UI

- 当前有设置卡片 `ui/settings.html`：全局默认、当前任务开关、暂停、运行标识和命令速查。
- 当前**没有**推荐结果卡片、采纳/忽略按钮或点击后自动重发能力。
- `🛰️` / `🛰️⏸️` 是由模型按协议选择追加的可选文字标识，不是原生常驻 UI，也不应被视为评估成功的唯一证据。

## 4. 架构总览

```text
Codex Desktop
│
├─ Hooks（SessionStart / UserPromptSubmit / Compact）
│   └─ scripts/model-watch-hook.mjs
│       ├─ 解析 session_id / turn_id / model / prompt
│       ├─ 处理 !model-watch 命令
│       ├─ 识别同一请求的 route ticket
│       └─ 注入协议上下文给当前主 Agent
│
├─ 当前主 Agent（同会话评估器）
│   └─ skills/model-watch/SKILL.md + src/protocol.mjs
│       ├─ 依据上下文判断 stay/change/uncertain/failed
│       └─ 调用 MCP 保存判断
│
├─ MCP Server（官方 SDK）
│   └─ scripts/model-watch-mcp.mjs
│       ├─ 读取/更新设置
│       ├─ 保存判断并创建短期 route ticket
│       └─ 暴露设置 UI 资源
│
└─ 本地状态层
    └─ src/state.mjs
        ├─ 全局与任务状态
        ├─ 原子写、PID + token 文件锁
        ├─ TTL 和状态规范化
        └─ 观察记录
```

## 5. 代码与资料地图

| 路径 | 作用 | 审阅重点 |
| --- | --- | --- |
| `README.md` | 对外中文产品说明与配图 | 不得与源码/手测冲突；不夸大硬阻断或 UI 能力 |
| `HANDOFF.md` | 当前工程接手摘要 | 版本、分支和“未做”范围是否仍准确 |
| `MEMORY.md` | 本地长期历史与决策 | 只作历史参考；以最新章节为准，文件默认不入 Git |
| `docs/manual-test-cases.md` | 桌面端手测验收 | P0/P1/P2 是否覆盖真实高风险边界 |
| `docs/agent-review-guide.md` | 本文 | 供后续审阅 Agent 快速上手 |
| `plugins/model-watch/.codex-plugin/plugin.json` | 插件清单、菜单文案、默认 Prompt | 入口不得误导为“已启用” |
| `plugins/model-watch/hooks/hooks.json` | Hook 注册 | 事件、超时、描述与真实语义一致 |
| `plugins/model-watch/.mcp.json` | MCP 启动入口 | 安装缓存路径下的 cwd 是否正确 |
| `plugins/model-watch/scripts/model-watch-hook.mjs` | Hook 主控制器 | 会话隔离、路由票据消费、失败放行、模型身份 |
| `plugins/model-watch/scripts/model-watch-mcp.mjs` | MCP SDK 服务 | 输入校验、精确 session、无正文落盘、工具/UI 契约 |
| `plugins/model-watch/src/protocol.mjs` | 注入给模型的行为协议 | 文案是否导致意外执行、误报或泄露内部元数据 |
| `plugins/model-watch/src/commands.mjs` | 命令解析 | 兼容性和普通任务误识别 |
| `plugins/model-watch/src/engine.mjs` | 哈希与判断结果校验 | `change` 的候选、当前模型和输出约束 |
| `plugins/model-watch/src/state.mjs` | 状态、迁移、锁 | 多进程安全、TTL、数据最小化、schema 兼容 |
| `plugins/model-watch/ui/settings.html` | MCP Apps 设置界面 | 状态同步、缺 session 时不得修改任务 |
| `tests/*.test.mjs` | Node 内置测试 | 是否验证行为而非重复实现细节 |
| `assets/readme/*.svg` | GitHub README 配图 | 仅说明已实现流程，不把可选标识画成主流程 |

## 6. 关键数据模型

### 6.1 全局配置

```json
{
  "schemaVersion": 3,
  "autoEnableNewTasks": false,
  "showStatusIndicator": true
}
```

### 6.2 任务状态（摘要）

```json
{
  "schemaVersion": 3,
  "sessionId": "sanitized-session-id",
  "enabled": true,
  "paused": false,
  "override": { "showStatusIndicator": true },
  "currentModel": "gpt-5.6-luna",
  "activeRequest": {
    "turnId": "...",
    "promptHash": "sha256",
    "originalModel": "gpt-5.6-luna",
    "commandAction": "check-inline"
  },
  "routeTicket": {
    "turnId": "...",
    "promptHash": "sha256",
    "originalModel": "gpt-5.6-luna",
    "recommendedModel": "gpt-5.6-sol",
    "expiresAt": "..."
  },
  "lastAssessment": {
    "status": "change",
    "recommendedModel": "gpt-5.6-sol",
    "rationale": "...",
    "evaluator": "same-session"
  },
  "observationHistory": []
}
```

约束：`routeTicket` 有 15 分钟 TTL；`observationHistory` 最多保留 12 条；所有字符串和哈希都会规范化；正文和附件不允许进入该状态。

### 6.3 并发与持久化

- 全局状态和每个任务状态分别使用独立 JSON 文件。
- 写入采用临时文件 + `renameSync` 原子替换，文件权限为 `0600`。
- 锁文件包含随机 `token`、`pid`、创建时间；仅确认 pid 已不存在时清理合法遗留锁。释放锁时必须核对 token，防止旧 owner 删除新 owner 的锁。
- 任何界面或 MCP 任务级操作必须携带精确 `sessionId`；禁止以“最近修改的任务”作为回退目标。

## 7. 判断协议与校验链

1. Hook 从 `input.model`、`model_slug`、`modelSlug`、`active_model`、`activeModel` 尝试读取当前模型；后续请求缺模型时使用已保存的 SessionStart 模型。
2. Hook 提供默认候选集：`gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol`；可用 `MODEL_WATCH_AVAILABLE_MODELS` 环境变量替换。
3. `protocol.mjs` 要求当前主 Agent 将每轮结论保存为 `stay | change | uncertain | failed`。
4. `model_watch_record_assessment` 强制 evaluator 写为 `same-session`，并由 `normalizeEngineResult` 校验：
   - `change` 必须包含候选列表中的模型；
   - 当前模型未知时 `change` 失败放行；
   - 推荐模型等于当前模型时 `change` 失败放行；
   - 非 `change` 不保存推荐模型。
5. 合法 `change` 创建 route ticket；下一次同 hash 的请求匹配即绕过评估、直接执行。
6. 对 ticket 的下一次请求会记录 `adopted`（实际模型等于推荐）、`kept`（等于原模型）、`other`（其他模型）或 `superseded`（新请求替代）。

## 8. 测试与验证现状

### 自动测试

```bash
npm ci
npm ci --prefix plugins/model-watch
npm test
git diff --check
```

当前 `npm test` 的基线为 **34 项通过**。测试覆盖：

- 命令解析与已删除命令拒绝；
- 启用、暂停、恢复、压缩恢复；
- SessionStart 模型与后续 prompt 模型缺失的回退；
- `change → route ticket → 原样重发 → 直接执行`；
- 不同请求替代旧建议；
- MCP 设置读写、精确 session 隔离、SDK 启动；
- schema 迁移、数据最小化、锁的死 owner 回收；
- README 资产与公开文案约束。

### 必须在真实桌面端复验的内容

自动测试不能证明宿主或主模型实际遵守协议。使用 `docs/manual-test-cases.md`，重点验证：

1. Hook 信任后是否真正运行；
2. `/` 选择插件与 `!model-watch on` 的状态是否不再混淆；
3. 主模型是否每轮调用 `model_watch_record_assessment`；
4. `change` 是否真的不执行主任务；
5. 手动切换/保持并重发后是否同线程续跑、不会重复评估；
6. 当前模型 slug 是否被宿主传入，避免推荐到当前模型；
7. 设置 UI 在多任务并发时是否不串写；
8. 旧任务热加载、Hook 重新信任、附件重发的实际行为。

## 9. 已知限制与审阅风险

### 产品与宿主风险

- 当前逻辑依赖主模型遵守 additional context。它不是可由插件强制的真正前置模型阻断。
- 宿主没有被本项目验证为可从 MCP UI 安全地重发原用户消息或附件，因此不应实现伪“一键继续”。
- 候选模型是静态默认列表，不代表宿主当前必然可选；可用性与别名尚未动态同步。
- `MODEL_WATCH_AVAILABLE_MODELS` 仅适用于本地开发或自行管理插件进程的环境；Codex 桌面端没有由本插件提供的候选模型编辑 UI。
- 路由票据只比较同会话 prompt hash；附件内容不在 hash 内，附件差异的严格保真目前不能承诺。
- `SHA-256` 不等于加密或不可猜测；低熵内容可被字典猜测。

### 文档/源码一致性关注点

- README 将状态标识描述为可选反馈；协议仍允许普通自然语言回复追加 `🛰️`。审阅时应确保两者都不把它宣传为核心工作流或成功证明。
- `hooks/hooks.json` 的描述仍含英文 “recommendation gate”。实际实现是同会话逻辑门，不是硬 gate；这是可以改进的公开元数据文案，但不应错误地改成“完全不拦截”。
- `MEMORY.md` 包含早期“子 Agent / 外部评估器已实现”等历史内容；这些已经被 v1.1.0 范围否定，不能作为当前能力依据。

## 10. 建议的审阅顺序

1. 先阅读 `README.md`、本文、`HANDOFF.md`、`docs/manual-test-cases.md`，明确产品契约。
2. 阅读 `commands.mjs` 和 `model-watch-hook.mjs`，画出 command / 普通请求 / route match / paused 四条路径。
3. 阅读 `protocol.mjs`，检查模型收到的指令是否完整、一致且不泄露元数据。
4. 阅读 `engine.mjs` 与 `model-watch-mcp.mjs`，验证 `change` 的输入、模型身份和候选校验。
5. 阅读 `state.mjs`，优先审查精确 session、文件锁、TTL、原子写和状态最小化。
6. 阅读 `settings.html` 与 MCP schema，检查全局设置和任务设置的同步边界。
7. 跑自动测试，再设计桌面端 P0/P1/P2 验证；不要因为测试绿灯而宣称端到端已跑通。

## 11. 可直接交给审阅 Agent 的任务模板

```text
请对模型哨兵进行只读技术与产品审阅。

先阅读：README.md、docs/agent-review-guide.md、HANDOFF.md、
docs/manual-test-cases.md、plugins/model-watch/src/、scripts/、ui/ 与 tests/。

以“按任务启用 → 当前主模型同会话判断 → stay 直接执行 / change 暂停 →
用户手动选模型并原样重发 → 同一请求直接执行”为唯一一期契约。

重点检查：
1. 文档、SVG、设置 UI、Skill、Hook、MCP 和测试是否一致；
2. 是否存在 change 误执行、重复执行、跨任务串写或模型身份误判；
3. route ticket 的 TTL、hash、并发、附件和重放边界；
4. 文件锁是否会被活进程错误回收或误删；
5. MCP SDK、输入校验、数据最小化、错误放行是否可靠；
6. 自动测试覆盖是否遗漏真实桌面端风险。

输出格式：按 P0/P1/P2 列出问题；每项给出证据（文件:行）、影响、复现条件、
最小修复建议和验证方式。不要修改文件、安装插件、提交、推送或扩大一期范围。
```

## 12. 变更纪律

- 修改产品逻辑时，同步检查 README、SVG、Skill、Hook、MCP、UI、手测和自动测试。
- 任何新增独立评估器必须先定义隐私、成本、超时、回退、上下文输入和会话一致性，并单独验证；不要在现有同会话路径上悄悄混入外部调用。
- 不使用 `git reset --hard`、`git checkout -- .` 覆盖用户工作区。
- 完成改动后至少运行 `npm test`、`git diff --check`；涉及 README 图时再运行 README 资产审计并视觉检查。
