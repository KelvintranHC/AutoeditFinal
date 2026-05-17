/**
 * Token usage tracking — ghi nhận từng bước / từng lần retry, tính chi phí USD/VNĐ.
 */

export type TokenStepId =
  | "mp3_to_srt"
  | "srt_sentence_normalize"
  | "meaning_beats"
  | "scene_keywords"
  | "scene_summaries_vi"
  | "keyword_generation"
  | "regenerate_keywords_en"
  | "video_selection_ai"
  | "metadata_caption";

export type TokenAttemptStatus = "success" | "failed" | "retry";

export interface TokenUsageAttempt {
  id: string;
  attemptIndex: number;
  status: TokenAttemptStatus;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  costVnd: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
  promptPreview?: string;
  outputPreview?: string;
}

export interface TokenUsageStepRecord {
  stepId: TokenStepId;
  stepLabel: string;
  attempts: TokenUsageAttempt[];
}

export interface ProjectTokenUsageLog {
  version: 1;
  projectId?: string;
  updatedAt: string;
  steps: TokenUsageStepRecord[];
}

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export interface TokenUsageSettings {
  usdToVndRate: number;
  modelPricing: Record<string, ModelPricing>;
  storePromptDetails: boolean;
}

export const DEFAULT_USD_TO_VND = 25_500;

/** USD / 1M tokens — ước tính Gemini (có thể sửa trong Settings). */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "gemini-2.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-2.0-flash-lite": { inputPer1M: 0.075, outputPer1M: 0.3 },
  default: { inputPer1M: 0.1, outputPer1M: 0.4 },
  local: { inputPer1M: 0, outputPer1M: 0 },
};

export const TOKEN_STEP_LABELS: Record<TokenStepId, string> = {
  mp3_to_srt: "MP3 → SRT (transcribe)",
  srt_sentence_normalize: "Chuẩn hóa SRT theo câu",
  meaning_beats: "AI gom phân cảnh (meaning beats)",
  scene_keywords: "AI tạo keyword tiếng Anh",
  scene_summaries_vi: "AI ghi chú phân cảnh (VI)",
  keyword_generation: "AI tạo keyword (danh sách)",
  regenerate_keywords_en: "Render lại keywords EN (scene gộp)",
  video_selection_ai: "AI chọn video phù hợp",
  metadata_caption: "AI metadata / caption",
};

export function emptyTokenUsageLog(projectId?: string): ProjectTokenUsageLog {
  return {
    version: 1,
    projectId,
    updatedAt: new Date().toISOString(),
    steps: [],
  };
}

export function parseTokenUsageLog(json?: string | null): ProjectTokenUsageLog {
  if (!json?.trim()) return emptyTokenUsageLog();
  try {
    const parsed = JSON.parse(json) as ProjectTokenUsageLog;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.steps)) {
      return emptyTokenUsageLog();
    }
    return {
      version: 1,
      projectId: parsed.projectId,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      steps: parsed.steps.map((s) => ({
        stepId: s.stepId,
        stepLabel: s.stepLabel || TOKEN_STEP_LABELS[s.stepId as TokenStepId] || s.stepId,
        attempts: Array.isArray(s.attempts) ? s.attempts : [],
      })),
    };
  } catch {
    return emptyTokenUsageLog();
  }
}

export function parseTokenSettingsFromConfig(
  config: Record<string, unknown> | null | undefined,
): TokenUsageSettings {
  let modelPricing = { ...DEFAULT_MODEL_PRICING };
  const rawPricing = config?.tokenModelPricingJson;
  if (typeof rawPricing === "string" && rawPricing.trim()) {
    try {
      const p = JSON.parse(rawPricing) as Record<string, ModelPricing>;
      modelPricing = { ...modelPricing, ...p };
    } catch {
      /* giữ mặc định */
    }
  }
  return {
    usdToVndRate:
      typeof config?.tokenUsdToVnd === "number" && config.tokenUsdToVnd > 0
        ? config.tokenUsdToVnd
        : DEFAULT_USD_TO_VND,
    modelPricing,
    storePromptDetails: Boolean(config?.tokenStorePromptDetails),
  };
}

export function tokenSettingsToConfigFields(
  s: TokenUsageSettings,
): Record<string, unknown> {
  return {
    tokenUsdToVnd: s.usdToVndRate,
    tokenModelPricingJson: JSON.stringify(s.modelPricing),
    tokenStorePromptDetails: s.storePromptDetails,
  };
}

export function resolveModelPricing(
  model: string,
  pricing: Record<string, ModelPricing>,
): ModelPricing {
  const key = model.trim().toLowerCase();
  if (pricing[key]) return pricing[key];
  const partial = Object.keys(pricing).find(
    (k) => k !== "default" && key.includes(k),
  );
  if (partial) return pricing[partial];
  return pricing.default || DEFAULT_MODEL_PRICING.default;
}

export function parseGeminiUsageMetadata(meta: unknown): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const m = meta as Record<string, unknown> | null | undefined;
  if (!m) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const prompt = Number(m.promptTokenCount) || 0;
  const candidates = Number(m.candidatesTokenCount) || 0;
  const thoughts =
    Number(
      (m as { thoughtsTokenCount?: number }).thoughtsTokenCount ||
        (m as { candidatesTokenDetails?: { thoughtsTokenCount?: number } })
          .candidatesTokenDetails?.thoughtsTokenCount,
    ) || 0;
  const outputTokens = candidates + thoughts;
  const total =
    Number(m.totalTokenCount) || prompt + outputTokens;
  return {
    inputTokens: prompt,
    outputTokens,
    totalTokens: total,
  };
}

export function computeTokenCostUsd(
  inputTokens: number,
  outputTokens: number,
  model: string,
  pricing: Record<string, ModelPricing>,
): number {
  const p = resolveModelPricing(model, pricing);
  return (
    (inputTokens / 1_000_000) * p.inputPer1M +
    (outputTokens / 1_000_000) * p.outputPer1M
  );
}

function newAttemptId(): string {
  return `ta_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function truncateForStorage(text: string, max = 2000): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export interface BuildAttemptInput {
  model: string;
  status: TokenAttemptStatus;
  usageMetadata?: unknown;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
  promptPreview?: string;
  outputPreview?: string;
  pricing: Record<string, ModelPricing>;
  usdToVndRate: number;
}

export function buildTokenAttempt(input: BuildAttemptInput): TokenUsageAttempt {
  const { inputTokens, outputTokens, totalTokens } = parseGeminiUsageMetadata(
    input.usageMetadata,
  );
  const costUsd = computeTokenCostUsd(
    inputTokens,
    outputTokens,
    input.model,
    input.pricing,
  );
  return {
    id: newAttemptId(),
    attemptIndex: 0,
    status: input.status,
    model: input.model,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    costVnd: costUsd * input.usdToVndRate,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: Math.round(input.durationMs),
    error: input.error,
    promptPreview: input.promptPreview,
    outputPreview: input.outputPreview,
  };
}

export function appendTokenAttempt(
  log: ProjectTokenUsageLog,
  stepId: TokenStepId,
  attempt: TokenUsageAttempt,
): ProjectTokenUsageLog {
  const steps = [...log.steps];
  let step = steps.find((s) => s.stepId === stepId);
  if (!step) {
    step = {
      stepId,
      stepLabel: TOKEN_STEP_LABELS[stepId],
      attempts: [],
    };
    steps.push(step);
  } else {
    step = { ...step, attempts: [...step.attempts] };
    const idx = steps.findIndex((s) => s.stepId === stepId);
    steps[idx] = step;
  }
  const attemptIndex = step.attempts.length + 1;
  step.attempts.push({
    ...attempt,
    attemptIndex,
    status:
      attemptIndex > 1 && attempt.status === "success"
        ? "retry"
        : attempt.status,
  });
  return {
    ...log,
    updatedAt: new Date().toISOString(),
    steps,
  };
}

export interface TokenUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalCostVnd: number;
  totalAttempts: number;
  byStep: {
    stepId: TokenStepId;
    stepLabel: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    costVnd: number;
    attemptCount: number;
  }[];
  byModel: {
    model: string;
    totalTokens: number;
    costUsd: number;
    costVnd: number;
  }[];
  topModelByTokens: string | null;
  topStepByCost: { stepId: TokenStepId; stepLabel: string; costVnd: number } | null;
}

export function summarizeTokenUsageLog(
  log: ProjectTokenUsageLog,
): TokenUsageSummary {
  const byStepMap = new Map<
    string,
    TokenUsageSummary["byStep"][0]
  >();
  const byModelMap = new Map<string, TokenUsageSummary["byModel"][0]>();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let totalCostVnd = 0;
  let totalAttempts = 0;

  for (const step of log.steps) {
    for (const a of step.attempts) {
      totalInputTokens += a.inputTokens;
      totalOutputTokens += a.outputTokens;
      totalTokens += a.totalTokens;
      totalCostUsd += a.costUsd;
      totalCostVnd += a.costVnd;
      totalAttempts++;

      const st =
        byStepMap.get(step.stepId) ||
        ({
          stepId: step.stepId,
          stepLabel: step.stepLabel,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          costVnd: 0,
          attemptCount: 0,
        } as TokenUsageSummary["byStep"][0]);
      st.inputTokens += a.inputTokens;
      st.outputTokens += a.outputTokens;
      st.totalTokens += a.totalTokens;
      st.costUsd += a.costUsd;
      st.costVnd += a.costVnd;
      st.attemptCount += 1;
      byStepMap.set(step.stepId, st);

      const mm =
        byModelMap.get(a.model) ||
        ({
          model: a.model,
          totalTokens: 0,
          costUsd: 0,
          costVnd: 0,
        } as TokenUsageSummary["byModel"][0]);
      mm.totalTokens += a.totalTokens;
      mm.costUsd += a.costUsd;
      mm.costVnd += a.costVnd;
      byModelMap.set(a.model, mm);
    }
  }

  const byStep = [...byStepMap.values()].sort((a, b) => b.costVnd - a.costVnd);
  const byModel = [...byModelMap.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens,
  );

  return {
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalCostUsd,
    totalCostVnd,
    totalAttempts,
    byStep,
    byModel,
    topModelByTokens: byModel[0]?.model ?? null,
    topStepByCost: byStep[0]
      ? {
          stepId: byStep[0].stepId,
          stepLabel: byStep[0].stepLabel,
          costVnd: byStep[0].costVnd,
        }
      : null,
  };
}

/** Ghi bước xử lý local (0 token) — vd. chuẩn hóa SRT theo câu. */
export function recordLocalProcessingStep(
  log: ProjectTokenUsageLog,
  stepId: TokenStepId,
  opts?: { note?: string; durationMs?: number },
): ProjectTokenUsageLog {
  const now = new Date().toISOString();
  return appendTokenAttempt(
    log,
    stepId,
    buildTokenAttempt({
      model: "local",
      status: "success",
      startedAt: now,
      endedAt: now,
      durationMs: opts?.durationMs ?? 0,
      outputPreview: opts?.note,
      pricing: DEFAULT_MODEL_PRICING,
      usdToVndRate: DEFAULT_USD_TO_VND,
    }),
  );
}
