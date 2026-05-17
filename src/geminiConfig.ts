/**
 * Gemini generateContent defaults for structured JSON analysis (SRT / keywords).
 * Caps thinking tokens on 2.5 models — largest cost driver in token breakdown.
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

/** 0 = thinking off; small budget for semantic beat splitting only. */
const THINKING_BUDGET_BY_STAGE: Record<GeminiAnalysisStage, number> = {
  meaning_beats: 512,
  scene_keywords: 256,
  scene_summaries_vi: 128,
  keyword_generation: 0,
};

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
  return {
    responseMimeType: "application/json" as const,
    maxOutputTokens: maxOutputTokensForStage(stage, opts),
    thinkingConfig: {
      thinkingBudget: THINKING_BUDGET_BY_STAGE[stage],
      includeThoughts: false,
    },
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
  return {
    maxOutputTokens: Math.min(
      GEMINI_TRANSCRIBE_MAX_OUTPUT_CAP,
      3072 + minutes * 1100,
    ),
    thinkingConfig: {
      thinkingBudget: 0,
      includeThoughts: false,
    },
  };
}
