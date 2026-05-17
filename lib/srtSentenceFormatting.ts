/**
 * Gom transcript / cue SRT thành block kết thúc tại câu hoàn chỉnh (. ? ! … ...).
 */

export type TimedTextChunk = {
  text: string;
  startSec: number;
  endSec: number;
};

const COMPLETE_SENTENCE_HEAD_RE =
  /^([\s\S]+?(?:\.{3}|[.!?…]+))(\s+|$)/;

export function formatSrtTimestamp(seconds: number): string {
  const sec = Math.max(0, seconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function parseSrtTimeToSeconds(timeStr: string): number {
  const t = timeStr.trim().replace(/\./g, ",");
  /** HH:MM:SS,mmm hoặc H:MM:SS,mmm (Gemini đôi khi bỏ 0 đầu giờ) */
  const full = t.match(
    /^(\d{1,2}):(\d{2}):(\d{2}),(\d{1,3})$/,
  );
  if (full) {
    const msRaw = full[4].padEnd(3, "0").slice(0, 3);
    return (
      parseInt(full[1], 10) * 3600 +
      parseInt(full[2], 10) * 60 +
      parseInt(full[3], 10) +
      parseInt(msRaw, 10) / 1000
    );
  }
  /** MM:SS,mmm (một số model bỏ cụm giờ) */
  const short = t.match(/^(\d{1,2}):(\d{2}),(\d{1,3})$/);
  if (short) {
    const msRaw = short[3].padEnd(3, "0").slice(0, 3);
    return (
      parseInt(short[1], 10) * 60 +
      parseInt(short[2], 10) +
      parseInt(msRaw, 10) / 1000
    );
  }
  return 0;
}

/** Parse SRT thành các đoạn có timecode (mỗi cue gốc = 1 chunk). */
export function parseSrtToTimedChunks(srt: string): TimedTextChunk[] {
  const chunks: TimedTextChunk[] = [];
  const rawBlocks = srt.trim().split(/\r?\n\r?\n+/);
  for (const rb of rawBlocks) {
    const lines = rb.split(/\r?\n/).map((l) => l.trim());
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const match = timeLine.match(
      /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})/,
    );
    if (!match) continue;
    const idx = lines.indexOf(timeLine);
    const text = lines
      .slice(idx + 1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    chunks.push({
      text,
      startSec: parseSrtTimeToSeconds(match[1]),
      endSec: parseSrtTimeToSeconds(match[2]),
    });
  }
  return chunks;
}

function formatSrtFromSentenceBlocks(
  blocks: { start: number; end: number; text: string }[],
): string {
  if (!blocks.length) {
    return "1\n00:00:00,000 --> 00:00:05,000\n(Không có nội dung)\n\n";
  }
  return blocks
    .map((b, i) => {
      const end = Math.max(b.start + 0.05, b.end);
      return `${i + 1}\n${formatSrtTimestamp(b.start)} --> ${formatSrtTimestamp(end)}\n${b.text}\n`;
    })
    .join("\n");
}

/**
 * Gom các chunk transcript (Whisper / cue SRT nhỏ) thành SRT theo câu hoàn chỉnh.
 */
export function mergeTimedChunksIntoSentenceSrt(
  chunks: TimedTextChunk[],
): string {
  if (!chunks.length) {
    return formatSrtFromSentenceBlocks([]);
  }

  const sentences: { start: number; end: number; text: string }[] = [];
  let pending = "";
  let acc: { start: number; end: number } | null = null;

  const pushSentence = (raw: string) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text || !acc) return;
    sentences.push({
      start: acc.start,
      end: Math.max(acc.end, acc.start + 0.05),
      text,
    });
  };

  for (const ch of chunks) {
    const chunk = ch.text.replace(/\s+/g, " ").trim();
    if (!chunk) continue;

    if (!acc) {
      acc = { start: ch.startSec, end: ch.endSec };
      pending = chunk;
    } else {
      acc.start = Math.min(acc.start, ch.startSec);
      acc.end = Math.max(acc.end, ch.endSec);
      pending = `${pending} ${chunk}`;
    }

    let guard = 0;
    while (pending && guard++ < 128) {
      const m = pending.match(COMPLETE_SENTENCE_HEAD_RE);
      if (!m) break;
      pushSentence(m[1]);
      pending = pending.slice(m[0].length).trim();
      if (pending) {
        acc = { start: ch.startSec, end: ch.endSec };
      } else {
        acc = null;
      }
    }
  }

  if (pending.trim() && acc) {
    pushSentence(pending);
  }

  if (!sentences.length) {
    const text = chunks
      .map((c) => c.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return formatSrtFromSentenceBlocks([
      {
        start: chunks[0].startSec,
        end: chunks[chunks.length - 1].endSec,
        text: text || "(Không có nội dung)",
      },
    ]);
  }

  return formatSrtFromSentenceBlocks(sentences);
}

/** Gỡ markdown fence / text thừa từ output Gemini trước khi parse SRT. */
export function sanitizeGeminiSrtOutput(raw: string): string {
  let t = (raw || "").trim().replace(/^\uFEFF/, "");
  const fenced = t.match(/^```(?:srt|text)?\s*\r?\n?([\s\S]*?)```\s*$/i);
  if (fenced) t = fenced[1].trim();
  return t;
}

/** Thời điểm kết thúc của cue cuối trong SRT (giây). */
export function getSrtTimelineEndSec(srt: string): number {
  const chunks = parseSrtToTimedChunks(srt);
  if (!chunks.length) return 0;
  return Math.max(...chunks.map((c) => c.endSec));
}

/** Dịch toàn bộ timecode SRT thêm offsetSec (dùng khi gộp nhiều đoạn transcribe). */
export function shiftSrtTimestamps(srt: string, offsetSec: number): string {
  if (!offsetSec || !srt.trim()) return srt;
  const chunks = parseSrtToTimedChunks(srt).map((c) => ({
    text: c.text,
    startSec: c.startSec + offsetSec,
    endSec: c.endSec + offsetSec,
  }));
  if (!chunks.length) return srt;
  return mergeTimedChunksIntoSentenceSrt(chunks);
}

/** Gộp nhiều đoạn SRT (đã shift offset nếu cần) thành một file theo thời gian. */
export function concatSrtParts(parts: string[]): string {
  const merged: TimedTextChunk[] = [];
  for (const part of parts) {
    if (!part?.trim()) continue;
    merged.push(...parseSrtToTimedChunks(part));
  }
  if (!merged.length) return "";
  merged.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  return mergeTimedChunksIntoSentenceSrt(merged);
}

/** Chuẩn hóa file SRT có sẵn: gom cue ngắn thành block theo câu. */
export function mergeSrtCuesIntoSentenceBlocks(srt: string): string {
  const trimmed = (srt || "").trim();
  if (!trimmed) return trimmed;
  const chunks = parseSrtToTimedChunks(trimmed);
  if (!chunks.length) return trimmed;
  return mergeTimedChunksIntoSentenceSrt(chunks);
}
