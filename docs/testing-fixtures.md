# 模型哨兵：确定性测试夹具

这是一组仅供开发、验收和排障使用的内部命令。它们**不调用真实推荐引擎**、不执行用户主任务，也不计入真实评估历史；结果只写入当前任务的测试记录。

先在一个专用测试任务中启用哨兵：

```text
!model-watch on
```

然后发送：

```text
!model-watch test <case>
```

测试夹具不在设置 UI 中提供入口，以避免与真实产品流程混淆。设置页“评估记录”会把测试记录标为“测试”。

## Case 列表

| 命令 | 前置模型 | 固定结果 | 用途 |
| --- | --- | --- | --- |
| `!model-watch test card` | 任意可识别模型 | `change` 到一个不同候选 | 基础建议卡、一次性续跑和实际模型观察 |
| `!model-watch test upgrade` | Luna 或 Terra | Luna → Terra；Terra → Sol | 验证更高能力候选的建议与卡片 |
| `!model-watch test downgrade` | Sol 或 Terra | Sol → Terra；Terra → Luna | 验证“最低充分模型”可以降级，不依赖真实引擎碰巧判断 |
| `!model-watch test stay` | 任意 | `stay` | 验证主任务直接执行、无切换卡片 |
| `!model-watch test uncertain` | 任意 | `uncertain` | 验证信息不足时安全放行 |
| `!model-watch test fixed-fallback` | 任意 | fixed failed → same-session stay | 验证失败与回退为两条测试记录，且不伪造成本 |
| `!model-watch test unknown-model` | 任意 | `failed`，无推荐 | 验证模型身份未知时不会生成切换建议 |
| `!model-watch test card-ack` | 任意 | `change` | 使用“已选择模型，继续任务”按钮，检查 `acknowledged` 与实际模型分开记录 |
| `!model-watch test card-ignore` | 任意 | `change` | 使用“忽略建议，继续任务”按钮，检查 `ignored` 与实际模型分开记录 |
| `!model-watch test expired` | 任意 | `change` | 不点击卡片，等待 ticket 过期后发送新输入，验证 `expired` 观察 |

## 验收边界

- `upgrade`、`downgrade` 仅构造测试结果，不主张真实引擎应对同样任务得出相同结论。
- 目前 `card-ack`、`card-ignore` 与 `expired` 复用真实 gate/Hook 行为；最后一步必须在 Codex Desktop 由人点击或输入验证。
- 如果当前宿主没有接通卡片 follow-up，卡片会提示原样重新发送上一条任务；这不能视为“一键恢复”已通过。
- 不要在真实业务任务中使用这些命令，避免干扰该任务的测试历史和卡片状态。

## 目录与额度策略测试

这部分不是推荐引擎夹具，而是设置与候选边界的确定性验证。先在设置页主动刷新“模型目录与额度”，记下显示的 Codex 限额桶剩余比例：

1. 保持 GPT 优先开启，把阈值设为低于当前剩余比例：候选只应保留 GPT 原生模型。
2. 将阈值设为高于当前剩余比例：刷新后的目录中，外部模型可作为候选参与判断。
3. 关闭 GPT 优先：不依赖额度比例，完整已刷新目录均可参与判断。

该比例不是任何单一 GPT 型号的精确余额；此测试验证的是产品的“开放外部候选”开关，而不是额度计费。
