import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { normalizeEngineResult } from "./engine.mjs";
import { estimateFixedEvaluatorCost, unavailableCost } from "./cost.mjs";

const TIMEOUT_MS = 20_000;

export async function runFixedEvaluator({ prompt, currentModel, availableModels, evaluatorModel, timeoutMs = TIMEOUT_MS, env = process.env }) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const mocked = env.MODEL_WATCH_FIXED_EVALUATOR_RESULT;
  if (mocked) return withTelemetry(normalizeFixedResult(mocked, availableModels, currentModel, evaluatorModel, "mock"), { started, startedAt, prompt });
  if (!prompt.trim() || !currentModel) return withTelemetry(failed("当前请求或当前模型未知，无法运行固定评估器", evaluatorModel), { started, startedAt, prompt });
  const executable = resolveCodexExecutable(env);
  const instruction = buildEvaluatorPrompt({ prompt, currentModel, availableModels, evaluatorModel });
  try {
    const output = await execute(executable, evaluatorModel, instruction, timeoutMs, env);
    return withTelemetry(normalizeFixedResult(output, availableModels, currentModel, evaluatorModel, "codex-exec"), { started, startedAt, prompt: instruction });
  } catch (error) {
    return withTelemetry(failed(error instanceof Error ? error.message : "固定评估器调用失败", evaluatorModel), { started, startedAt, prompt });
  }
}

function resolveCodexExecutable(env) {
  if (env.MODEL_WATCH_CODEX_BIN) return env.MODEL_WATCH_CODEX_BIN;
  const desktopCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return existsSync(desktopCodex) ? desktopCodex : "codex";
}

function buildEvaluatorPrompt({ prompt, currentModel, availableModels, evaluatorModel }) {
  return [
    "你是模型哨兵的只读独立评估器。只输出一个 JSON 对象；不要调用工具，不要执行用户任务，不要解释。",
    `评估模型：${evaluatorModel}`,
    `当前执行模型：${currentModel}`,
    `候选模型：${availableModels.join(", ") || "unknown"}`,
    "你只看到本轮精确输入，不能假设看到了历史、附件、工具结果或隐藏指令。缺少这些且会影响判断时返回 uncertain。",
    "目标：选择能以合理成本稳定完成本轮剩余工作的最低充分模型。若候选模型能实质降低遗漏、错误、返工或不安全结论风险，返回 change；不要因为当前模型可能完成就默认 stay。",
    "JSON schema：{\"status\":\"stay|change|uncertain|failed\",\"recommendedModel\":string|null,\"rationale\":string,\"confidence\":\"low|medium|high\",\"signals\":string[],\"decisionBasis\":string[]}",
    "本轮精确输入如下：",
    prompt
  ].join("\n");
}

function execute(executable, model, input, timeoutMs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-rules",
      "--color", "never", "--model", model, "-"
    ], {
      env: { ...env, MODEL_WATCH_BYPASS: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("固定评估器超时，已回退同会话判断"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`固定评估器未完成（退出码 ${code}）：${stderr.trim().slice(0, 240) || "无诊断信息"}`));
    });
    child.stdin.end(input);
  });
}

function withTelemetry(result, { started, startedAt, prompt }) {
  const completed = result.status !== "failed";
  return {
    ...result,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    cost: completed
      ? estimateFixedEvaluatorCost({ model: result.evaluatorModel, prompt })
      : unavailableCost("固定评估未完成，无法可靠估算实际消耗。")
  };
}

function normalizeFixedResult(value, availableModels, currentModel, evaluatorModel, transport) {
  const result = normalizeEngineResult(value, availableModels, currentModel);
  return {
    ...result,
    evaluator: "fixed-codex",
    evaluatorMode: "fixed-codex",
    evaluatorModel,
    transport,
    contextCoverage: "current-input-only"
  };
}

function failed(rationale, evaluatorModel) {
  return {
    status: "failed",
    recommendedModel: null,
    rationale,
    evaluator: "fixed-codex",
    evaluatorMode: "fixed-codex",
    evaluatorModel,
    transport: "codex-exec",
    contextCoverage: "current-input-only",
    confidence: null,
    signals: [],
    decisionBasis: []
  };
}
