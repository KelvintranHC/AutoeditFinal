/**
 * MP3 → SRT chỉ dùng Gemini — tối ưu tốc độ: inline audio nhỏ, song song 2–3 đoạn,
 * kiểm tra chất lượng thực tế (không ép timeline phủ 72% vì khoảng lặng).
 */

import type { GoogleGenAI } from "@google/genai";
import { buildGeminiTranscribeConfig } from "../geminiConfig";
import { generateContentWithFallback } from "./geminiClient";
import {
  mergeChunkedSrtParts,
  getAudioDurationSec,
  prepareAudioSegmentsForTranscription,
  srtCoverageRatio,
  type PreparedAudioSegment,
} from "./audioTranscription";
import {
  getSrtTimelineEndSec,
  parseSrtToTimedChunks,
  sanitizeGeminiSrtOutput,
} from "../../lib/srtSentenceFormatting";

/**
 * Gemini với 1 request thường chỉ trả ~30–90s SRT dù audio dài — không dùng single
 * cho file > ngưỡng này.
 */
export const GEMINI_TRANSCRIBE_SINGLE_MAX_SEC = 90;

/** ~2 phút/đoạn — ít bị cắt cụt mỗi lần gọi. */
export const GEMINI_TRANSCRIBE_SEGMENT_SEC = 120;

/** Sau ghép SRT: nếu cue cuối < tỷ lệ này × độ dài file → transcribe lại chunked. */
const FULL_TIMELINE_MIN_RATIO = 0.62;

const INLINE_AUDIO_MAX_BYTES = 6 * 1024 * 1024;
const TRANSCRIBE_CONCURRENCY = 3;
const MAX_SEGMENT_RETRIES = 1;
const FILE_ACTIVE_POLL_MS = 600;
const FILE_ACTIVE_TIMEOUT_MS = 45_000;

export type GeminiTranscribeInvoke = (
  fn: () => Promise<{ text?: string | null }>,
  meta: { promptPreview: string; label?: string },
) => Promise<{ text?: string | null }>;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatMmSs(seconds: number): string {
  const sec = Math.max(0, Math.floor(seconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function timelineCoversAudio(srt: string, durationSec: number): boolean {
  if (durationSec <= 45) return true;
  const end = getSrtTimelineEndSec(sanitizeGeminiSrtOutput(srt));
  const need = Math.min(
    durationSec - 20,
    durationSec * FULL_TIMELINE_MIN_RATIO,
  );
  return end >= Math.max(need, 30);
}

export function planGeminiTranscription(durationSec: number): {
  mode: "single" | "chunked";
  segmentSec: number;
  estimatedChunks: number;
} {
  if (durationSec <= GEMINI_TRANSCRIBE_SINGLE_MAX_SEC) {
    return { mode: "single", segmentSec: durationSec, estimatedChunks: 1 };
  }
  const segmentSec = GEMINI_TRANSCRIBE_SEGMENT_SEC;
  return {
    mode: "chunked",
    segmentSec,
    estimatedChunks: Math.ceil(durationSec / segmentSec),
  };
}

function buildGeminiSrtPrompt(opts: {
  segment?: PreparedAudioSegment;
  totalSegments?: number;
  totalDurationSec?: number;
}): string {
  const { segment, totalSegments, totalDurationSec } = opts;
  const segmentBlock =
    segment && totalSegments && totalDurationSec
      ? `
Đoạn ${segment.index + 1}/${totalSegments} (~${formatMmSs(segment.startSec)}–${formatMmSs(segment.endSec)} trong file ${formatMmSs(totalDurationSec)}).
Timecode SRT bắt đầu 00:00:00 cho đoạn này. Transcribe hết audio đoạn.`
      : "";

  return `Tạo phụ đề SRT từ audio.${segmentBlock}

BẮT BUỘC: Transcribe TOÀN BỘ audio từ đầu đến cuối — không dừng sớm, không chỉ 30–60 giây đầu. Timecode cue cuối phải sát thời điểm kết thúc lời nói trong đoạn này.

Quy tắc:
- Mỗi block = một câu hoàn chỉnh (. ? ! …). Không cắt giữa câu.
- Timestamp HH:MM:SS,mmm (chuẩn 2 chữ số giờ) theo thời gian thực trong audio.
- Giữ nguyên ngôn ngữ gốc, không dịch.
- Chỉ trả SRT thuần (số thứ tự, timecode, text).`;
}

function geminiFileState(f: { state?: unknown }): string {
  if (typeof f.state === "string") return f.state;
  return (f.state as { name?: string } | undefined)?.name ?? "";
}

async function waitForGeminiFileActive(
  ai: GoogleGenAI,
  fileName: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < FILE_ACTIVE_TIMEOUT_MS) {
    const f = await ai.files.get({ name: fileName });
    const state = geminiFileState(f);
    if (state === "ACTIVE") return;
    if (state === "FAILED") {
      throw new Error("Gemini không xử lý được file âm thanh.");
    }
    await sleep(FILE_ACTIVE_POLL_MS);
  }
  throw new Error("Hết thời gian chờ Gemini xử lý file.");
}

async function deleteGeminiFileQuietly(ai: GoogleGenAI, fileName?: string) {
  if (!fileName) return;
  try {
    await ai.files.delete({ name: fileName });
  } catch {
    /* ignore */
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = (reader.result as string).split(",")[1];
      if (!b64) reject(new Error("Không đọc được audio."));
      else resolve(b64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Chất lượng SRT — không dùng mỗi coverage vì có khoảng lặng giữa câu. */
function assessSegmentSrtQuality(
  raw: string,
  segmentDurSec: number,
): { acceptable: boolean; coverage: number; cueCount: number } {
  const sanitized = sanitizeGeminiSrtOutput(raw);
  const cues = parseSrtToTimedChunks(sanitized);
  const cueCount = cues.length;
  const textLen = cues.map((c) => c.text).join(" ").length;
  const coverage = srtCoverageRatio(sanitized, segmentDurSec);
  const minCues = Math.max(1, Math.floor(segmentDurSec / 45));
  const acceptable =
    cueCount >= minCues ||
    textLen >= Math.max(40, segmentDurSec * 1.5) ||
    coverage >= 0.28;
  return { acceptable, coverage, cueCount };
}

async function transcribeBlobWithGemini(opts: {
  ai: GoogleGenAI;
  apiKey: string;
  model: string;
  blob: Blob;
  mimeType: string;
  prompt: string;
  segmentDurationSec: number;
  invoke: GeminiTranscribeInvoke;
}): Promise<string> {
  const {
    ai,
    apiKey,
    model,
    blob,
    mimeType,
    prompt,
    segmentDurationSec,
    invoke,
  } = opts;
  const useInline = blob.size <= INLINE_AUDIO_MAX_BYTES;
  let uploadedName: string | undefined;

  try {
    let audioPart: { inlineData: { mimeType: string; data: string } } | {
      fileData: { fileUri: string; mimeType: string };
    };

    if (useInline) {
      const data = await blobToBase64(blob);
      audioPart = {
        inlineData: {
          mimeType: mimeType || "audio/mpeg",
          data,
        },
      };
    } else {
      const uploaded = await ai.files.upload({
        file: blob,
        config: {
          mimeType: mimeType || "audio/mpeg",
          displayName: `mp3-srt-${Date.now()}`,
        },
      });
      uploadedName = uploaded.name;
      const state = geminiFileState(uploaded);
      if (uploaded.name && state !== "ACTIVE") {
        await waitForGeminiFileActive(ai, uploaded.name);
      }
      if (!uploaded.uri || !uploaded.mimeType) {
        throw new Error("Gemini Files API không trả URI.");
      }
      audioPart = {
        fileData: {
          fileUri: uploaded.uri,
          mimeType: uploaded.mimeType,
        },
      };
    }

    const result = await invoke(
      () =>
        generateContentWithFallback({
          ai,
          apiKey,
          model,
          contents: [
            {
              role: "user",
              parts: [audioPart, { text: prompt }],
            },
          ],
          config: buildGeminiTranscribeConfig({ segmentDurationSec }),
        }),
      { promptPreview: prompt },
    );

    return result.text || "";
  } finally {
    if (!useInline) {
      await deleteGeminiFileQuietly(ai, uploadedName);
    }
  }
}

async function transcribeOneSegment(opts: {
  ai: GoogleGenAI;
  apiKey: string;
  model: string;
  blob: Blob;
  mimeType: string;
  segment: PreparedAudioSegment;
  totalSegments: number;
  totalDurationSec: number;
  invoke: GeminiTranscribeInvoke;
}): Promise<string> {
  const segmentDur = Math.max(
    1,
    opts.segment.endSec - opts.segment.startSec,
  );
  const prompt = buildGeminiSrtPrompt({
    segment: opts.segment,
    totalSegments: opts.totalSegments,
    totalDurationSec: opts.totalDurationSec,
  });

  let lastRaw = "";
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= MAX_SEGMENT_RETRIES; attempt++) {
    try {
      const raw = await transcribeBlobWithGemini({
        ai: opts.ai,
        apiKey: opts.apiKey,
        model: opts.model,
        blob: opts.blob,
        mimeType: opts.mimeType,
        prompt:
          attempt > 0
            ? `${prompt}\n\nThử lại: transcribe đầy đủ, không bỏ sót cuối đoạn.`
            : prompt,
        segmentDurationSec: segmentDur,
        invoke: opts.invoke,
      });
      lastRaw = sanitizeGeminiSrtOutput(raw);

      if (!lastRaw || lastRaw.length < 8) {
        throw new Error("Gemini trả SRT rỗng.");
      }

      const q = assessSegmentSrtQuality(lastRaw, segmentDur);
      if (q.acceptable) return lastRaw;

      if (attempt >= MAX_SEGMENT_RETRIES && q.cueCount >= 1) {
        console.warn(
          `[mp3-srt] đoạn ${opts.segment.index + 1}: coverage ${(q.coverage * 100).toFixed(0)}% — vẫn giữ ${q.cueCount} cue`,
        );
        return lastRaw;
      }

      throw new Error(
        `SRT đoạn quá ít nội dung (${q.cueCount} cue, phủ ~${Math.round(q.coverage * 100)}%).`,
      );
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < MAX_SEGMENT_RETRIES) await sleep(400);
    }
  }

  if (lastRaw && parseSrtToTimedChunks(lastRaw).length > 0) {
    return lastRaw;
  }
  throw lastErr ?? new Error("Transcribe đoạn thất bại.");
}

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function transcribeChunkedGemini(opts: {
  file: File;
  durationSec: number;
  ai: GoogleGenAI;
  apiKey: string;
  model: string;
  invoke: GeminiTranscribeInvoke;
  onProgress?: (msg: string) => void;
  /** Mặc định GEMINI_TRANSCRIBE_SEGMENT_SEC; giảm khi retry (vd. 90). */
  segmentSec?: number;
}): Promise<string> {
  const segmentSec = opts.segmentSec ?? GEMINI_TRANSCRIBE_SEGMENT_SEC;
  const nChunks = Math.ceil(opts.durationSec / segmentSec);
  opts.onProgress?.(
    `Chia ~${nChunks} đoạn (~${Math.round(segmentSec / 60)} phút/đoạn), transcribe song song...`,
  );

  const prepared = await prepareAudioSegmentsForTranscription(
    opts.file,
    segmentSec,
    opts.onProgress,
  );
  const total = prepared.chunks.length;
  let done = 0;

  try {
    const partResults = await runPool(
      prepared.chunks,
      TRANSCRIBE_CONCURRENCY,
      async (chunk) => {
        opts.onProgress?.(
          `Gemini SRT — đoạn ${chunk.index + 1}/${total} (${formatMmSs(chunk.startSec)}–${formatMmSs(chunk.endSec)})...`,
        );
        try {
          const srt = await transcribeOneSegment({
            ai: opts.ai,
            apiKey: opts.apiKey,
            model: opts.model,
            blob: chunk.blob,
            mimeType: chunk.blob.type || "audio/mpeg",
            segment: chunk,
            totalSegments: total,
            totalDurationSec: opts.durationSec,
            invoke: opts.invoke,
          });
          done++;
          opts.onProgress?.(`Hoàn thành ${done}/${total} đoạn...`);
          return { startSec: chunk.startSec, srt, ok: true as const };
        } catch (e) {
          console.error(`[mp3-srt] đoạn ${chunk.index + 1} lỗi:`, e);
          return {
            startSec: chunk.startSec,
            srt: "",
            ok: false as const,
            error: e,
          };
        }
      },
    );

    const okParts = partResults
      .filter((p) => p.ok && p.srt)
      .sort((a, b) => a.startSec - b.startSec);

    if (!okParts.length) {
      const firstErr = partResults.find((p) => !p.ok)?.error;
      throw firstErr instanceof Error
        ? firstErr
        : new Error("Không transcribe được đoạn nào.");
    }

    if (okParts.length < total) {
      opts.onProgress?.(
        `Cảnh báo: ${okParts.length}/${total} đoạn thành công — đang gộp phần có SRT...`,
      );
    }

    return mergeChunkedSrtParts(
      okParts.map((p) => ({ startSec: p.startSec, srt: p.srt })),
    );
  } finally {
    prepared.cleanup();
  }
}

async function transcribeSingleGemini(opts: {
  file: File;
  durationSec: number;
  ai: GoogleGenAI;
  apiKey: string;
  model: string;
  invoke: GeminiTranscribeInvoke;
  onProgress?: (msg: string) => void;
}): Promise<string> {
  opts.onProgress?.(
    `Gemini SRT (~${formatMmSs(opts.durationSec)}) — một lần gọi...`,
  );
  const prompt = buildGeminiSrtPrompt({});
  let lastRaw = "";
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= MAX_SEGMENT_RETRIES; attempt++) {
    try {
      const raw = await transcribeBlobWithGemini({
        ai: opts.ai,
        apiKey: opts.apiKey,
        model: opts.model,
        blob: opts.file,
        mimeType: opts.file.type || "audio/mpeg",
        prompt:
          attempt > 0
            ? `${prompt}\n\nThử lại: transcribe đầy đủ đến hết file.`
            : prompt,
        segmentDurationSec: opts.durationSec,
        invoke: opts.invoke,
      });
      lastRaw = sanitizeGeminiSrtOutput(raw);
      if (!lastRaw || lastRaw.length < 8) {
        throw new Error("Gemini trả SRT rỗng.");
      }
      const q = assessSegmentSrtQuality(lastRaw, opts.durationSec);
      if (q.acceptable || q.cueCount >= 1) return lastRaw;
      throw new Error(`SRT quá ngắn (phủ ~${Math.round(q.coverage * 100)}%).`);
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }

  if (lastRaw && parseSrtToTimedChunks(lastRaw).length > 0) return lastRaw;
  throw lastErr ?? new Error("Gemini transcribe thất bại.");
}

export async function transcribeMp3ToSrtWithGemini(opts: {
  file: File;
  ai: GoogleGenAI;
  apiKey: string;
  model: string;
  invoke: GeminiTranscribeInvoke;
  onProgress?: (msg: string) => void;
}): Promise<string> {
  const durationSec = await getAudioDurationSec(opts.file);
  const plan = planGeminiTranscription(durationSec);

  const tryChunked = (segmentSec: number, label: string) => {
    opts.onProgress?.(label);
    return transcribeChunkedGemini({
      ...opts,
      durationSec,
      segmentSec,
    });
  };

  if (plan.mode === "chunked") {
    let srt = await tryChunked(
      GEMINI_TRANSCRIBE_SEGMENT_SEC,
      `File ~${formatMmSs(durationSec)} — transcribe theo đoạn...`,
    );
    if (!timelineCoversAudio(srt, durationSec)) {
      srt = await tryChunked(
        90,
        `SRT vẫn ngắn so với audio — thử đoạn 90 giây...`,
      );
    }
    return srt;
  }

  try {
    let srt = await transcribeSingleGemini({ ...opts, durationSec });
    if (!timelineCoversAudio(srt, durationSec)) {
      opts.onProgress?.(
        `SRT chỉ ~${formatMmSs(getSrtTimelineEndSec(sanitizeGeminiSrtOutput(srt)))} trong ${formatMmSs(durationSec)} — chuyển chunked...`,
      );
      srt = await tryChunked(GEMINI_TRANSCRIBE_SEGMENT_SEC, "");
      if (!timelineCoversAudio(srt, durationSec)) {
        srt = await tryChunked(90, "");
      }
    }
    return srt;
  } catch (singleErr) {
    console.warn("[mp3-srt] Single-call failed, fallback chunked:", singleErr);
    opts.onProgress?.("Một lần gọi thất bại — chia đoạn...");
    let srt = await tryChunked(GEMINI_TRANSCRIBE_SEGMENT_SEC, "");
    if (!timelineCoversAudio(srt, durationSec)) {
      srt = await tryChunked(90, "");
    }
    return srt;
  }
}
