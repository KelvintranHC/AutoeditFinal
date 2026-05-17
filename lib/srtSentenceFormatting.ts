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
  const m = timeStr.trim().match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return 0;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4], 10) / 1000
  );
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
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/,
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

/** Chuẩn hóa file SRT có sẵn: gom cue ngắn thành block theo câu. */
export function mergeSrtCuesIntoSentenceBlocks(srt: string): string {
  const trimmed = (srt || "").trim();
  if (!trimmed) return trimmed;
  const chunks = parseSrtToTimedChunks(trimmed);
  if (!chunks.length) return trimmed;
  return mergeTimedChunksIntoSentenceSrt(chunks);
}
