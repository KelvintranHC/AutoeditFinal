/**
 * Gọi Gemini generateContent: retry ngắn + fallback qua server proxy khi trình duyệt
 * báo "Failed to fetch" (firewall, mạng, CORS edge case, payload lớn).
 */

import type { GoogleGenAI } from "@google/genai";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isLikelyNetworkFetchFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("network request failed") ||
    m.includes("load failed") ||
    err.name === "TypeError"
  );
}

function extractGeminiRestText(data: unknown): string {
  const d = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = d?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => p?.text).filter(Boolean).join("");
}

export async function generateContentViaServerProxy(params: {
  apiKey: string;
  model: string;
  contents: unknown;
  /** Cùng field mà @google/genai dùng là `config` — forward REST dưới tên generationConfig */
  config?: unknown;
}): Promise<{ text?: string | null; usageMetadata?: unknown }> {
  const key = params.apiKey.trim();
  if (!key) {
    throw new Error("Thiếu Gemini API Key (Settings).");
  }

  const res = await fetch("/api/ai/gemini-generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-gemini-api-key": key,
    },
    body: JSON.stringify({
      model: params.model,
      contents: params.contents,
      generationConfig: params.config ?? undefined,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data as { error?: string }).error ||
      `Gemini proxy HTTP ${res.status}`;
    throw new Error(msg);
  }

  const text =
    typeof (data as { text?: string }).text === "string"
      ? (data as { text }).text
      : extractGeminiRestText(data);

  return {
    text: text || null,
    usageMetadata: (data as { usageMetadata?: unknown }).usageMetadata,
  };
}

export async function generateContentWithFallback(params: {
  ai: GoogleGenAI;
  apiKey: string;
  model: string;
  contents: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["contents"];
  config?: Parameters<GoogleGenAI["models"]["generateContent"]>[0]["config"];
}): Promise<{ text?: string | null; usageMetadata?: unknown }> {
  const { ai, apiKey, model, contents, config } = params;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await ai.models.generateContent({
        model,
        contents,
        config,
      } as Parameters<GoogleGenAI["models"]["generateContent"]>[0]);
    } catch (e) {
      lastErr = e;
      if (!isLikelyNetworkFetchFailure(e)) throw e;
      await sleep(500 * (attempt + 1));
    }
  }

  try {
    return await generateContentViaServerProxy({
      apiKey,
      model,
      contents,
      config,
    });
  } catch (proxyErr) {
    const a = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const b =
      proxyErr instanceof Error ? proxyErr.message : String(proxyErr);
    throw new Error(
      `Không kết nối được Gemini (${b}). Trình duyệt: ${a}. Kiểm tra mạng, VPN, tường lửa; chạy app qua «npm run dev» (cùng cổng API); thử tắt extension chặn request.`,
    );
  }
}
