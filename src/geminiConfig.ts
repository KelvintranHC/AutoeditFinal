/**
 * Gemini generateContent defaults for structured JSON analysis (SRT / keywords).
 * Caps thinking tokens on 2.5 models — largest cost driver in token breakdown.
 */

export type GeminiAnalysisStage =
  | "meaning_beats"
  | "scene_keywords"
  | "scene_summaries_vi"
  | "keyword_generation";

/** Enough for large scene lists; lower than 8192 to discourage runaway JSON. */
export const GEMINI_JSON_MAX_OUTPUT_TOKENS = 4096;

/** 0 = thinking off; small budget for semantic beat splitting only. */
const THINKING_BUDGET_BY_STAGE: Record<GeminiAnalysisStage, number> = {
  meaning_beats: 512,
  scene_keywords: 256,
  scene_summaries_vi: 128,
  keyword_generation: 0,
};

export function buildGeminiJsonConfig(stage: GeminiAnalysisStage) {
  return {
    responseMimeType: "application/json" as const,
    maxOutputTokens: GEMINI_JSON_MAX_OUTPUT_TOKENS,
    thinkingConfig: {
      thinkingBudget: THINKING_BUDGET_BY_STAGE[stage],
      includeThoughts: false,
    },
  };
}
