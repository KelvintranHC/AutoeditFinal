/**
 * Hỗ trợ MP3 → SRT: duration, chia đoạn (server ffmpeg hoặc browser), gộp SRT.
 */

import {
  concatSrtParts,
  getSrtTimelineEndSec,
  shiftSrtTimestamps,
} from "../../lib/srtSentenceFormatting";

export const TRANSCRIBE_GEMINI_MAX_SINGLE_SEC = 90;
export const TRANSCRIBE_SEGMENT_SEC = 120;

export type TranscriptionSegmentMeta = {
  index: number;
  startSec: number;
  endSec: number;
  url: string;
};

export type TranscriptionSegmentsResponse = {
  workId: string;
  durationSec: number;
  segmentSec: number;
  chunks: TranscriptionSegmentMeta[];
};

export type PreparedAudioSegment = {
  index: number;
  startSec: number;
  endSec: number;
  blob: Blob;
};

const SEGMENT_API_PATHS = [
  "/api/audio/transcription-segments",
  "/api/transcribe/segments",
] as const;

export function getAudioDurationSec(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    const cleanup = () => URL.revokeObjectURL(url);
    audio.onloadedmetadata = () => {
      const d = audio.duration;
      cleanup();
      if (!Number.isFinite(d) || d <= 0) {
        reject(new Error("Không đọc được độ dài file âm thanh."));
        return;
      }
      resolve(d);
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("Không đọc được metadata âm thanh."));
    };
    audio.src = url;
  });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/** Encode AudioBuffer → WAV Blob (Gemini chấp nhận audio/wav). */
function encodeWavFromAudioBuffer(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const pcm = new Int16Array(length * numChannels);
  let offset = 0;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      pcm[offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  const dataSize = pcm.length * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  new Uint8Array(out, 44).set(new Uint8Array(pcm.buffer));
  return new Blob([out], { type: "audio/wav" });
}

/** Chia audio trên trình duyệt — không cần API server (fallback khi 404). */
export async function sliceAudioFileInBrowser(
  file: File,
  segmentSec: number,
): Promise<PreparedAudioSegment[]> {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const total = decoded.duration;
    const out: PreparedAudioSegment[] = [];
    let index = 0;
    for (let start = 0; start < total - 0.01; start += segmentSec) {
      const end = Math.min(total, start + segmentSec);
      const startSample = Math.floor(start * decoded.sampleRate);
      const endSample = Math.floor(end * decoded.sampleRate);
      const len = Math.max(1, endSample - startSample);
      const slice = ctx.createBuffer(
        decoded.numberOfChannels,
        len,
        decoded.sampleRate,
      );
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        slice.copyToChannel(
          decoded.getChannelData(ch).subarray(startSample, endSample),
          ch,
        );
      }
      out.push({
        index: index++,
        startSec: start,
        endSec: end,
        blob: encodeWavFromAudioBuffer(slice),
      });
    }
    return out;
  } finally {
    await ctx.close();
  }
}

async function postSegmentRequest(
  path: string,
  file: File,
  segmentSec: number,
): Promise<Response> {
  const form = new FormData();
  form.append("audio", file);
  form.append("segmentSec", String(segmentSec));
  return fetch(path, { method: "POST", body: form });
}

export async function prepareTranscriptionSegments(
  file: File,
  segmentSec = TRANSCRIBE_SEGMENT_SEC,
): Promise<TranscriptionSegmentsResponse> {
  let lastErr = "Chia đoạn âm thanh thất bại";
  for (const path of SEGMENT_API_PATHS) {
    const res = await postSegmentRequest(path, file, segmentSec);
    if (res.ok) {
      return res.json() as Promise<TranscriptionSegmentsResponse>;
    }
    const err = await res.json().catch(() => ({}));
    lastErr =
      (err as { error?: string }).error ||
      `Chia đoạn thất bại (${res.status}) tại ${path}`;
    if (res.status !== 404) {
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr);
}

export async function deleteTranscriptionSegmentsWork(
  workId: string,
): Promise<void> {
  await Promise.all(
    [
      `/api/audio/transcription-segments/${encodeURIComponent(workId)}`,
      `/api/transcribe/segments/${encodeURIComponent(workId)}`,
    ].map((url) => fetch(url, { method: "DELETE" }).catch(() => {})),
  );
}

export async function fetchSegmentBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Không tải được đoạn âm thanh (${res.status})`);
  }
  return res.blob();
}

/**
 * Chuẩn bị các đoạn audio: ưu tiên server (ffmpeg), fallback browser (Web Audio).
 */
export async function prepareAudioSegmentsForTranscription(
  file: File,
  segmentSec = TRANSCRIBE_SEGMENT_SEC,
  onProgress?: (msg: string) => void,
): Promise<{
  durationSec: number;
  chunks: PreparedAudioSegment[];
  cleanup: () => void;
}> {
  const durationSec = await getAudioDurationSec(file);

  try {
    const seg = await prepareTranscriptionSegments(file, segmentSec);
    onProgress?.("Đã chia đoạn trên server — tải các đoạn...");
    const chunks: PreparedAudioSegment[] = await Promise.all(
      seg.chunks.map(async (c) => ({
        index: c.index,
        startSec: c.startSec,
        endSec: c.endSec,
        blob: await fetchSegmentBlob(c.url),
      })),
    );
    return {
      durationSec: seg.durationSec,
      chunks,
      cleanup: () => {
        void deleteTranscriptionSegmentsWork(seg.workId);
      },
    };
  } catch (serverErr) {
    const msg =
      serverErr instanceof Error ? serverErr.message : String(serverErr);
    const useBrowser =
      msg.includes("not found") ||
      msg.includes("404") ||
      msg.includes("Chia đoạn");
    if (!useBrowser) throw serverErr;

    console.warn("[mp3-srt] Server segment API unavailable — browser slice", msg);
    onProgress?.(
      "Chia đoạn trên trình duyệt (Web Audio) — không cần API server...",
    );
    const chunks = await sliceAudioFileInBrowser(file, segmentSec);
    if (!chunks.length) {
      throw new Error("Không chia được file âm thanh.");
    }
    return {
      durationSec,
      chunks,
      cleanup: () => {},
    };
  }
}

export function mergeChunkedSrtParts(
  parts: { startSec: number; srt: string }[],
): string {
  const shifted = parts.map((p) => ({
    startSec: p.startSec,
    srt: shiftSrtTimestamps(p.srt, p.startSec),
  }));
  return concatSrtParts(shifted.map((p) => p.srt));
}

export function srtCoverageRatio(
  srt: string,
  expectedDurationSec: number,
): number {
  if (expectedDurationSec <= 0) return 1;
  return getSrtTimelineEndSec(srt) / expectedDurationSec;
}
