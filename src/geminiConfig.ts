/**
 * Gemini generateContent defaults cho phân tích JSON (SRT / keywords).
 * Gemini 2.5+ extended thinking: `thinkingBudget` phải ∈ [512, 24576] hoặc bỏ hẳn
 * `thinkingConfig` để tắt thinking (đừng gửi 0 — hay bị INVALID_ARGUMENT).
 */

export type GeminiAnalysisStage =
  | "meaning_beats"
  | "scene_keywords"
  | "scene_summaries_vi"
  | "keyword_generation";

/** MP3 → SRT: output text thuần, token scale theo độ dài đoạn. */
export const GEMINI_TRANSCRIBE_MAX_OUTPUT_CAP = 65536;

/** Default cap; per-stage overrides may scale with scene/line count. */
export const GEMINI_JSON_MAX_OUTPUT_TOKENS = 4096;

export const GEMINI_JSON_MAX_OUTPUT_CAP = 8192;

const GEMINI_THINKING_BUDGET_MIN = 512;
const GEMINI_THINKING_BUDGET_MAX = 24576;

/** Desired raw budgets — values < MIN are clamped; 0 ⇒ thinking off (omit config). */
const THINKING_BUDGET_BY_STAGE: Record<GeminiAnalysisStage, number> = {
  meaning_beats: 1024,
  scene_keywords: 1024,
  scene_summaries_vi: 1024,
  keyword_generation: 0,
};

function sanitizeThinkingConfig(
  rawBudget: number,
): { thinkingBudget: number; includeThoughts: false } | undefined {
  if (!Number.isFinite(rawBudget) || rawBudget <= 0) return undefined;
  const thinkingBudget = Math.min(
    GEMINI_THINKING_BUDGET_MAX,
    Math.max(GEMINI_THINKING_BUDGET_MIN, Math.floor(rawBudget)),
  );
  return { thinkingBudget, includeThoughts: false };
}

export function maxOutputTokensForStage(
  stage: GeminiAnalysisStage,
  opts?: { sceneCount?: number; lineCount?: number },
): number {
  if (stage === "scene_keywords" && opts?.sceneCount) {
    return Math.min(
      GEMINI_JSON_MAX_OUTPUT_CAP,
      520 + opts.sceneCount * 220,
    );
  }
  if (stage === "scene_summaries_vi" && opts?.sceneCount) {
    return Math.min(
      GEMINI_JSON_MAX_OUTPUT_CAP,
      400 + opts.sceneCount * 120,
    );
  }
  if (stage === "meaning_beats" && opts?.lineCount) {
    return Math.min(
      GEMINI_JSON_MAX_OUTPUT_CAP,
      600 + opts.lineCount * 45,
    );
  }
  return GEMINI_JSON_MAX_OUTPUT_TOKENS;
}

export function buildGeminiJsonConfig(
  stage: GeminiAnalysisStage,
  opts?: { sceneCount?: number; lineCount?: number },
) {
  const thinkingConfig = sanitizeThinkingConfig(
    THINKING_BUDGET_BY_STAGE[stage],
  );
  return {
    responseMimeType: "application/json" as const,
    maxOutputTokens: maxOutputTokensForStage(stage, opts),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
}

/** Config cho transcribe âm thanh → SRT (không JSON). */
export function buildGeminiTranscribeConfig(opts?: {
  segmentDurationSec?: number;
}) {
  const minutes = Math.max(
    1,
    Math.ceil((opts?.segmentDurationSec ?? 300) / 60),
  );
  /** Transcribe không cần extended thinking — không gửi thinkingConfig. */
  return {
    maxOutputTokens: Math.min(
      GEMINI_TRANSCRIBE_MAX_OUTPUT_CAP,
      3072 + minutes * 1100,
    ),
  };
}
