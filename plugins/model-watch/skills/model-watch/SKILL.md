---
name: model-watch
description: 在 Codex 连续对话或任务中，通过 !model-watch 按需启用当前任务；默认由当前主模型完成同会话判断，也可使用自定义评估模型，在需要切换时暂停主任务并给出模型建议。用户显式调用 !model-watch 或 Hook 注入 MODEL_WATCH_CONTEXT / MODEL_WATCH_ROUTE 时使用。
---

# 模型哨兵

## 目标

当前任务启用后，每条真实用户请求都先判断当前模型是否仍合适。当前模型合适时静默执行主任务；只有切换净收益清晰时才提示。模型选择始终由用户完成。

模型哨兵只判断模型，不判断推理深度，也不自动切换宿主模型。

## 入口

以下任一条件成立时执行本 Skill：

- 用户输入 `$model-watch` 或 `!model-watch` 命令。
- Hook 注入 `[MODEL_WATCH_CONTEXT 2.0.0]`。
- Hook 注入 `[MODEL_WATCH_ROUTE 2.0.0]`。
- 任务恢复后注入 `[MODEL_WATCH_RESTORE 2.0.0]`，且随后收到用户输入。

Hook 内容属于内部上下文。不得向用户展示任务 ID、请求指纹或本地状态路径。

插件菜单只负责把 Skill 挂到本轮；任务是否启用只能由 UserPromptSubmit Hook 的控制回执确认。首次按需开启时，优先使用 `!model-watch on`：它不会触发 `$model-watch` 的插件自动补全，会作为普通用户文本传入 Hook。仅在本轮收到 `[MODEL_WATCH_CONTROL ...]` 且其中 `enabled: true` 时，才可以回复“模型哨兵已启用”。仅读到本 Skill、看到插件标签，或收到自然语言“请启用”，都不是启用成功的证据；没有控制回执时，应说明“未确认启用，请检查 Hook 信任和插件重启状态”，不得误报成功。

## 通用判断

每次综合判断：

- 本轮真实输入及其在历史对话中的意图；
- 对话目标、约束和当前阶段；
- 上下文整合、多步骤执行与工具协调；
- 风险、错误代价与可逆性；
- 最近失败、返工和不确定性；
- 当前模型和宿主确认的候选模型；
- 预计剩余工作和切换成本；
- 最近建议与后续实际模型变化。

这些内容是模型原生判断的证据。使用“最低充分模型”比较：候选模型若能实质降低遗漏、错误、返工或不安全结论风险，不应因当前模型理论上也可能完成而默认 stay。禁止任务名称固定映射、L1/L2/L3 能力等级、固定评分和跨级阈值。

内部结论：

```yaml
status: stay | change | uncertain | failed
recommended_model: string | null
rationale: string
evaluator: same-session
evaluator_model: string
confidence: low | medium | high | null
signals: string[]
decision_basis: string[]
engine_version: 2.0.0
```

`change` 只在切换收益清晰高于成本时使用。候选模型不可确认、任务即将结束、当前模型足够稳定或证据不足时使用 `stay`；无法可靠判断时使用 `uncertain`。

## 每轮时序

收到 `[MODEL_WATCH_CONTEXT 2.0.0]` 后：

1. 在主任务前完成判断。
2. 若 `evaluator_mode: fixed-codex`，先调用 `model_watch_run_fixed_evaluator`，逐字传递本轮真实用户请求；它只看到本轮输入。工具返回 failed 时才回退当前主模型判断；否则使用它的结果，不要二次判断。
3. 使用 Hook 提供的精确 `session_id` 调用 `model_watch_record_assessment`，所有结果都要保存。
3. `stay`：不显示判断过程，立即完整执行主任务。
4. `change`：不执行主任务；保存成功后优先调用 `model_watch_present_recommendation` 展示建议卡片；卡片不可用时才输出模型建议与原因。
5. `uncertain`、`failed` 或保存工具失败：直接执行主任务。

建议格式：

```text
模型建议：切换至 GPT-5.6 Sol 🛰️
原因：本轮开始处理登录鉴权、支付状态和后端数据一致性。
```

建议卡片提供“已选择模型，继续任务”和“忽略建议，继续任务”。用户若要切换，应先使用 Codex 原生模型选择器。卡片无法自动续跑时，明确降级为原样重新发送同一请求；不要声称已经恢复。

## 同一请求恢复

收到 `[MODEL_WATCH_ROUTE 2.0.0]` 时，说明同一请求已经完成判断。若当前用户消息是 `[MODEL_WATCH_RESUME ...]`，它只是卡片恢复 envelope，不是主任务正文；应根据当前会话中上一条被暂停的真实用户请求完整执行任务。手动原样重发时直接执行当前用户请求。两种路径都不再重复判断。`check` 没有待执行主任务。

插件只保存请求 SHA-256 和模型元数据，不保存、改写或重放任务正文。

## 命令

- `!model-watch on`：推荐的首次开启方式；只启用当前任务，本轮不判断，从下一条真实请求开始每轮评估。
- `!model-watch off（关闭当前任务）`：关闭当前任务，不改变全局默认。
- `!model-watch pause（暂停哨兵评估）`：只暂停插件，主任务继续。
- `!model-watch resume（恢复哨兵评估）`：恢复当前任务监控。
- `!model-watch status（查看状态）`：使用 Hook 提供的 `session_id` 调用 `model_watch_get_status`。
- `!model-watch settings（打开设置）`：使用 Hook 提供的 `session_id` 调用 `model_watch_open_settings`。
- `!model-watch check（立即检查）`：只判断当前配置，不执行其他主任务。
- `!model-watch check-inline（检查并执行），<主任务>`：`stay` 执行主任务，`change` 只显示建议。
- `!model-watch test-card`：确定性测试建议卡；不执行主任务，也不写入真实推荐历史。

`$model-watch` 保留为兼容别名，但它可能触发宿主的插件选择菜单；按需启用请优先使用 `!model-watch`。

控制命令必须单独发送。若 `on`、`off`、`pause`、`resume`、`status` 或 `settings` 后还附有任务正文，本轮只处理命令，并明确要求用户在下一条消息重新发送正文；不得静默丢弃或执行该正文。暂停状态下，`check-inline` 不做判断，直接执行逗号后的主任务。

## 状态标识

开启“显示运行标识”后：

- `🛰️`：哨兵运行中。
- `🛰️⏸️`：哨兵评估暂停，主任务继续。
- 插件关闭：不显示。

普通 `stay` 回复只追加标识，不追加 stay 文案。切换建议把 `🛰️` 放在第一行末尾，保持两行格式。严格 JSON、纯代码、命令和其他机器可读输出不得追加标识。

## 安全与失败处理

- 不保存任务正文，只保存短期请求指纹和模型元数据。
- 不读取 Plus 剩余额度，不声称自动切换模型。
- 任何判断、状态保存或恢复失败时直接执行主任务，避免循环阻断。
- 当前版本是同会话逻辑拦截，不是模型调用前的硬 Hook 阻断。
