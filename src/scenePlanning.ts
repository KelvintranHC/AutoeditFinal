/**
 * Scene Planning Engine: meaning beats (AI) + rule-based visual scenes + keyword batch (AI).
 */

export interface SubtitleBlock {
  lineIndex: number;
  startTime: number;
  endTime: number;
  text: string;
  /** Cue SRT gốc (0-based) khi block là câu đã gom từ nhiều cue */
  sourceCueStart?: number;
  sourceCueEnd?: number;
}

/** Câu hoàn chỉnh: kết thúc bằng . ? ! … hoặc ... (không coi xuống dòng SRT là hết câu). */
const COMPLETE_SENTENCE_HEAD_RE =
  /^([\s\S]+?(?:\.{3}|[.!?…]+))(\s+|$)/;

export interface MeaningBeat {
  start_line_index: number;
  end_line_index: number;
  summary_vi: string;
  topic: string;
  importance: number;
  suggested_visual_direction_en: string;
}

export interface PacingProfile {
  hookStartSec: number;
  hookEndSec: number;
  hookSceneMinSec: number;
  hookSceneMaxSec: number;
  bodySceneMinSec: number;
  bodySceneMaxSec: number;
  endingLastSec: number;
  endingSceneMinSec: number;
  endingSceneMaxSec: number;
  maxClipsPerMinute: number;
  maxTotalClips10MinMin: number;
  maxTotalClips10MinMax: number;
  allowClipReuse: boolean;
  storyblocksChoicesPerKeyword: number;
}

/** Giới hạn tuyệt đối cho «Tổng clip (~10 phút)» trong Style & Pacing. */
export const PACING_TOTAL_CLIPS_ABSOLUTE_MIN = 4;
export const PACING_TOTAL_CLIPS_ABSOLUTE_MAX = 120;

export function clampTotalClipsRange(
  min: number,
  max: number,
): Pick<PacingProfile, "maxTotalClips10MinMin" | "maxTotalClips10MinMax"> {
  let lo = Math.round(Number(min));
  let hi = Math.round(Number(max));
  if (!Number.isFinite(lo)) {
    lo = DEFAULT_PACING_PROFILE.maxTotalClips10MinMin;
  }
  if (!Number.isFinite(hi)) {
    hi = DEFAULT_PACING_PROFILE.maxTotalClips10MinMax;
  }
  lo = Math.min(
    PACING_TOTAL_CLIPS_ABSOLUTE_MAX,
    Math.max(PACING_TOTAL_CLIPS_ABSOLUTE_MIN, lo),
  );
  hi = Math.min(
    PACING_TOTAL_CLIPS_ABSOLUTE_MAX,
    Math.max(PACING_TOTAL_CLIPS_ABSOLUTE_MIN, hi),
  );
  if (lo > hi) hi = lo;
  return { maxTotalClips10MinMin: lo, maxTotalClips10MinMax: hi };
}

export function normalizePacingProfile(p: PacingProfile): PacingProfile {
  const clips = clampTotalClipsRange(
    p.maxTotalClips10MinMin,
    p.maxTotalClips10MinMax,
  );
  return { ...p, ...clips };
}

export const DEFAULT_PACING_PROFILE: PacingProfile = {
  hookStartSec: 0,
  hookEndSec: 60,
  hookSceneMinSec: 4,
  hookSceneMaxSec: 8,
  bodySceneMinSec: 15,
  bodySceneMaxSec: 25,
  endingLastSec: 30,
  endingSceneMinSec: 6,
  endingSceneMaxSec: 12,
  maxClipsPerMinute: 4,
  maxTotalClips10MinMin: 35,
  maxTotalClips10MinMax: 45,
  allowClipReuse: true,
  storyblocksChoicesPerKeyword: 5,
};

export interface VisualSceneDraft {
  startLine: number;
  endLine: number;
  startTime: number;
  endTime: number;
  durationSec: number;
  text: string;
  summaryVi: string;
  pacingZone: "hook" | "body" | "ending";
  topics: string[];
  visualHintsEn: string[];
}

export interface SceneKeywordPlan {
  scene_index: number;
  keywords: string[];
  fallback_keywords: string[];
  storyblocks_search_queries: string[];
}

export function pacingZoneAtTime(
  tSec: number,
  totalDurSec: number,
  p: PacingProfile,
): "hook" | "body" | "ending" {
  if (totalDurSec <= p.hookEndSec) {
    return tSec < totalDurSec * 0.35 ? "hook" : "body";
  }
  const endingStart = Math.max(0, totalDurSec - p.endingLastSec);
  if (tSec < p.hookEndSec) return "hook";
  if (tSec >= endingStart) return "ending";
  return "body";
}

export function sceneDurationBounds(
  zone: "hook" | "body" | "ending",
  p: PacingProfile,
): [number, number] {
  switch (zone) {
    case "hook":
      return [p.hookSceneMinSec, p.hookSceneMaxSec];
    case "ending":
      return [p.endingSceneMinSec, p.endingSceneMaxSec];
    default:
      return [p.bodySceneMinSec, p.bodySceneMaxSec];
  }
}

function maxBeatsPerZone(z: "hook" | "body" | "ending"): number {
  if (z === "hook") return 2;
  if (z === "ending") return 2;
  return 3;
}

function topicsCompatible(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x);
}

/** Ngân sách số clip từ Style & Pacing (min/max tổng clip ~10 phút). */
export function totalClipBudget(
  totalSec: number,
  p: PacingProfile,
): { min: number; max: number } {
  const lo = Math.max(
    PACING_TOTAL_CLIPS_ABSOLUTE_MIN,
    Math.min(p.maxTotalClips10MinMax, p.maxTotalClips10MinMin),
  );
  let hi = Math.max(
    lo,
    Math.min(PACING_TOTAL_CLIPS_ABSOLUTE_MAX, p.maxTotalClips10MinMax),
  );
  // Video rất ngắn: không ép nhiều clip hơn nội dung cho phép
  if (totalSec < 45) {
    hi = Math.min(hi, 2);
    return { min: Math.min(lo, hi), max: hi };
  }
  if (totalSec < 120) {
    hi = Math.min(hi, Math.max(lo, 3));
  }
  return { min: lo, max: hi };
}

function mergeAdjacentSceneDrafts(
  a: VisualSceneDraft,
  b: VisualSceneDraft,
  blocks: SubtitleBlock[],
  p: PacingProfile,
): VisualSceneDraft {
  const timelineOff = blocks[0]?.startTime ?? 0;
  const totalDur = Math.max(
    0.05,
    blocks[blocks.length - 1].endTime - timelineOff,
  );
  const z = pacingZoneAtTime(a.startTime - timelineOff, totalDur, p);
  return {
    startLine: a.startLine,
    endLine: b.endLine,
    startTime: a.startTime,
    endTime: b.endTime,
    durationSec: b.endTime - a.startTime,
    text: blocks
      .slice(a.startLine, b.endLine + 1)
      .map((x) => x.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    summaryVi: [a.summaryVi, b.summaryVi].filter(Boolean).join(" · "),
    pacingZone: z,
    topics: [...a.topics, ...b.topics],
    visualHintsEn: [...a.visualHintsEn, ...b.visualHintsEn],
  };
}

/**
 * Gom scene liền kề cho đến khi ≤ maxScenes.
 * Nới giới hạn duration dần nếu user đặt tổng clip thấp (vd. max = 4).
 */
function compressScenesIfNeeded(
  scenes: VisualSceneDraft[],
  blocks: SubtitleBlock[],
  p: PacingProfile,
  maxScenes: number,
): VisualSceneDraft[] {
  if (maxScenes <= 0 || scenes.length <= maxScenes) return scenes;

  let s = [...scenes];
  const timelineSpan =
    (blocks[blocks.length - 1]?.endTime ?? 0) - (blocks[0]?.startTime ?? 0);
  const avgPerScene =
    timelineSpan > 0 ? timelineSpan / maxScenes : p.bodySceneMaxSec * 2;

  const durationCaps: (number | null)[] = [
    Math.max(p.bodySceneMaxSec * 2, 42),
    Math.max(avgPerScene * 1.35, p.bodySceneMaxSec * 2.5),
    Math.max(avgPerScene * 2.2, timelineSpan * 0.95),
    null,
  ];

  for (const cap of durationCaps) {
    let guard = 0;
    while (s.length > maxScenes && s.length >= 2 && guard++ < 500) {
      let bestK = -1;
      let bestScore = Infinity;
      for (let k = 0; k < s.length - 1; k++) {
        const mergedDur = s[k + 1].endTime - s[k].startTime;
        if (cap !== null && mergedDur > cap) continue;
        if (mergedDur < bestScore) {
          bestScore = mergedDur;
          bestK = k;
        }
      }
      if (bestK < 0) break;
      s.splice(
        bestK,
        2,
        mergeAdjacentSceneDrafts(s[bestK], s[bestK + 1], blocks, p),
      );
    }
    if (s.length <= maxScenes) break;
  }

  return s;
}

/** Ép số scene nằm trong [min, max] sau split / pacing phụ. */
function enforceTotalClipBudget(
  scenes: VisualSceneDraft[],
  blocks: SubtitleBlock[],
  p: PacingProfile,
  budget: { min: number; max: number },
): VisualSceneDraft[] {
  let s = [...scenes];
  s = compressScenesIfNeeded(s, blocks, p, budget.max);

  if (s.length < budget.min && s.length >= 1 && budget.min > 1) {
    const timelineOff = blocks[0]?.startTime ?? 0;
    const totalDur = Math.max(
      0.05,
      blocks[blocks.length - 1].endTime - timelineOff,
    );
    let guard = 0;
    while (s.length < budget.min && guard++ < 200) {
      let splitIdx = -1;
      let longest = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i].durationSec > longest) {
          longest = s[i].durationSec;
          splitIdx = i;
        }
      }
      if (splitIdx < 0 || longest < 4) break;
      const sc = s[splitIdx];
      const parts = splitBlockRangeIntoVisualScenes(
        blocks,
        sc.startLine,
        sc.endLine,
        p,
        Math.max(4, longest / 2),
      );
      if (parts.length < 2) break;
      s.splice(splitIdx, 1, ...parts);
      if (s.length > budget.max) {
        s = compressScenesIfNeeded(s, blocks, p, budget.max);
      }
    }
  }

  return compressScenesIfNeeded(s, blocks, p, budget.max);
}

function mergeAdjacentVisualScenes(
  a: VisualSceneDraft,
  b: VisualSceneDraft,
  blocks: SubtitleBlock[],
  timelineOff: number,
  totalDur: number,
  p: PacingProfile,
): VisualSceneDraft {
  void timelineOff;
  void totalDur;
  return mergeAdjacentSceneDrafts(a, b, blocks, p);
}

/** Giảm số cảnh trong mỗi cửa sổ 60s khi vượt maxClipsPerMinute. */
function enforceMaxClipsPerMinute(
  scenes: VisualSceneDraft[],
  blocks: SubtitleBlock[],
  p: PacingProfile,
): VisualSceneDraft[] {
  if (scenes.length <= 1 || p.maxClipsPerMinute <= 0) return scenes;
  const timelineOff = blocks[0]?.startTime ?? 0;
  const totalDur = Math.max(
    0.05,
    blocks[blocks.length - 1].endTime - timelineOff,
  );
  let s = [...scenes];
  let guard = 0;
  while (guard++ < 300 && s.length >= 2) {
    const relStarts = s.map((sc) => sc.startTime - timelineOff);
    let problemIdx = -1;
    for (let i = 0; i < s.length; i++) {
      const t0 = relStarts[i];
      const n = relStarts.filter((st) => st >= t0 && st < t0 + 60).length;
      if (n > p.maxClipsPerMinute) {
        problemIdx = i;
        break;
      }
    }
    if (problemIdx < 0) break;
    const k = Math.max(0, Math.min(problemIdx, s.length - 2));
    const merged = mergeAdjacentVisualScenes(
      s[k],
      s[k + 1],
      blocks,
      timelineOff,
      totalDur,
      p,
    );
    const mergeZone = pacingZoneAtTime(
      merged.startTime - timelineOff,
      totalDur,
      p,
    );
    const [, maxDm] = sceneDurationBounds(mergeZone, p);
    if (merged.durationSec > maxDm * 1.35) {
      break;
    }
    s.splice(k, 2, merged);
  }
  return s;
}

function normalizeBeatIndices(b: MeaningBeat, lineCount: number): MeaningBeat {
  let s = Math.min(Math.max(0, b.start_line_index), lineCount - 1);
  let e = Math.min(Math.max(0, b.end_line_index), lineCount - 1);
  if (e < s) [s, e] = [e, s];
  return { ...b, start_line_index: s, end_line_index: e };
}

/** Ensure every line is covered by exactly one beat (fill gaps, merge overlaps). */
export function prepareMeaningBeats(
  raw: MeaningBeat[],
  lineCount: number,
): MeaningBeat[] {
  if (lineCount <= 0) return [];
  if (!raw.length) {
    return Array.from({ length: lineCount }, (_, i) => ({
      start_line_index: i,
      end_line_index: i,
      summary_vi: "",
      topic: "general",
      importance: 2,
      suggested_visual_direction_en: "relevant stock b-roll to narration",
    }));
  }

  const normalized = raw.map((b) => normalizeBeatIndices(b, lineCount));
  normalized.sort(
    (a, b) =>
      a.start_line_index - b.start_line_index ||
      a.end_line_index - b.end_line_index,
  );

  const merged: MeaningBeat[] = [];
  for (const b of normalized) {
    if (!merged.length) {
      merged.push({ ...b });
      continue;
    }
    const prev = merged[merged.length - 1];
    if (b.start_line_index <= prev.end_line_index + 1) {
      prev.end_line_index = Math.max(prev.end_line_index, b.end_line_index);
      prev.summary_vi = [prev.summary_vi, b.summary_vi].filter(Boolean).join(" · ");
      prev.topic = prev.topic || b.topic;
      prev.importance = Math.max(prev.importance, b.importance);
      prev.suggested_visual_direction_en =
        b.suggested_visual_direction_en || prev.suggested_visual_direction_en;
    } else {
      merged.push({ ...b });
    }
  }

  const filled: MeaningBeat[] = [];
  let cursor = 0;
  for (const b of merged) {
    while (cursor < b.start_line_index && cursor < lineCount) {
      filled.push({
        start_line_index: cursor,
        end_line_index: cursor,
        summary_vi: "",
        topic: "general",
        importance: 2,
        suggested_visual_direction_en: "generic contextual footage",
      });
      cursor++;
    }
    filled.push(b);
    cursor = Math.max(cursor, b.end_line_index + 1);
  }
  while (cursor < lineCount) {
    filled.push({
      start_line_index: cursor,
      end_line_index: cursor,
      summary_vi: "",
      topic: "general",
      importance: 2,
      suggested_visual_direction_en: "generic contextual footage",
    });
    cursor++;
  }

  filled.sort(
    (a, b) =>
      a.start_line_index - b.start_line_index ||
      a.end_line_index - b.end_line_index,
  );
  return filled;
}

/** Tách dải dòng SRT thành nhiều visual scene theo cap duration từng zone (pacing). */
export function splitBlockRangeIntoVisualScenes(
  blocks: SubtitleBlock[],
  lineStart: number,
  lineEnd: number,
  pacing: PacingProfile,
  /** Nếu set: ép chunk không dài hơn giá trị này (dùng khi AI trả 1 beat phủ cả file). */
  maxDurationCapSec?: number | null,
): VisualSceneDraft[] {
  if (!blocks.length || lineStart > lineEnd) return [];
  const lo = Math.max(0, lineStart);
  const hi = Math.min(blocks.length - 1, lineEnd);
  const timelineOff = blocks[0].startTime;
  const totalDur = Math.max(
    0.05,
    blocks[blocks.length - 1].endTime - timelineOff,
  );

  const out: VisualSceneDraft[] = [];
  let idx = lo;
  while (idx <= hi) {
    const startTime = blocks[idx].startTime;
    const relT = startTime - timelineOff;
    const zone = pacingZoneAtTime(relT, totalDur, pacing);
    const [, maxDm] = sceneDurationBounds(zone, pacing);
    const cap =
      typeof maxDurationCapSec === "number" && maxDurationCapSec > 0
        ? Math.min(maxDm, maxDurationCapSec)
        : maxDm;
    let endIdx = idx;
    while (endIdx + 1 <= hi) {
      const nextDur = blocks[endIdx + 1].endTime - startTime;
      if (nextDur > cap) break;
      endIdx++;
    }
    const endTime = blocks[endIdx].endTime;
    const text = blocks
      .slice(idx, endIdx + 1)
      .map((b) => b.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({
      startLine: idx,
      endLine: endIdx,
      startTime,
      endTime,
      durationSec: endTime - startTime,
      text,
      summaryVi: text.slice(0, 200),
      pacingZone: zone,
      topics: [],
      visualHintsEn: [],
    });
    idx = endIdx + 1;
  }
  return out;
}

function sceneTextFromBlockRange(
  blocks: SubtitleBlock[],
  startLine: number,
  endLine: number,
): string {
  const lo = Math.max(0, Math.min(startLine, blocks.length - 1));
  const hi = Math.max(lo, Math.min(endLine, blocks.length - 1));
  return blocks
    .slice(lo, hi + 1)
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Đồng bộ scene với dải dòng SRT — text/timing luôn lấy từ blocks. */
export function rebuildVisualSceneFromBlockRange(
  template: VisualSceneDraft,
  blocks: SubtitleBlock[],
  startLine: number,
  endLine: number,
  p: PacingProfile,
): VisualSceneDraft {
  const lo = Math.max(0, Math.min(startLine, blocks.length - 1));
  const hi = Math.max(lo, Math.min(endLine, blocks.length - 1));
  const timelineOff = blocks[0]?.startTime ?? 0;
  const totalDur = Math.max(
    0.05,
    blocks[blocks.length - 1].endTime - timelineOff,
  );
  const startTime = blocks[lo].startTime;
  const endTime = blocks[hi].endTime;
  const relStart = startTime - timelineOff;
  return {
    ...template,
    startLine: lo,
    endLine: hi,
    startTime,
    endTime,
    durationSec: Math.max(0.05, endTime - startTime),
    text: sceneTextFromBlockRange(blocks, lo, hi),
    pacingZone: pacingZoneAtTime(relStart, totalDur, p),
  };
}

/**
 * Đảm bảo mọi dòng SRT (0..n-1) thuộc đúng một scene liền mạch; rebuild text từ blocks.
 */
export function repairVisualSceneLineCoverage(
  scenes: VisualSceneDraft[],
  blocks: SubtitleBlock[],
  p: PacingProfile,
  budget: { min: number; max: number },
): VisualSceneDraft[] {
  const n = blocks.length;
  if (n === 0) return [];

  const sorted = [...scenes].sort(
    (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
  );

  const segments: { start: number; end: number; template: VisualSceneDraft }[] =
    [];

  if (!sorted.length) {
    segments.push({
      start: 0,
      end: n - 1,
      template: {
        startLine: 0,
        endLine: n - 1,
        startTime: blocks[0].startTime,
        endTime: blocks[n - 1].endTime,
        durationSec: blocks[n - 1].endTime - blocks[0].startTime,
        text: sceneTextFromBlockRange(blocks, 0, n - 1),
        summaryVi: "",
        pacingZone: "body",
        topics: [],
        visualHintsEn: [],
      },
    });
  } else {
    let cursor = 0;
    for (const sc of sorted) {
      if (cursor >= n) break;
      const idealStart = Math.max(0, Math.min(sc.startLine, n - 1));

      if (idealStart > cursor) {
        if (segments.length > 0) {
          segments[segments.length - 1].end = idealStart - 1;
        } else {
          segments.push({
            start: cursor,
            end: idealStart - 1,
            template: sc,
          });
        }
        cursor = idealStart;
      }

      const start = Math.max(cursor, idealStart);
      const end = Math.max(start, Math.min(n - 1, sc.endLine));
      segments.push({ start, end, template: sc });
      cursor = end + 1;
    }

    if (cursor < n) {
      if (segments.length > 0) {
        segments[segments.length - 1].end = n - 1;
      } else {
        segments.push({ start: 0, end: n - 1, template: sorted[0] });
      }
    }
  }

  let result = segments.map(({ start, end, template }) =>
    rebuildVisualSceneFromBlockRange(template, blocks, start, end, p),
  );

  result = compressScenesIfNeeded(result, blocks, p, budget.max);
  result = result.map((sc) =>
    rebuildVisualSceneFromBlockRange(sc, blocks, sc.startLine, sc.endLine, p),
  );

  return result;
}

/** Chuẩn hóa chuỗi SRT để so khớp (unicode + khoảng trắng). */
export function normalizeSrtConcatenatedText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function validateSrtSceneTextIntegrity(
  blocks: SubtitleBlock[],
  scenes: Pick<VisualSceneDraft, "text" | "startLine" | "endLine">[],
): { ok: boolean; missingLineCount: number } {
  const n = blocks.length;
  if (n === 0) return { ok: true, missingLineCount: 0 };

  const covered = new Uint8Array(n);
  for (const sc of scenes) {
    const lo = Math.max(0, Math.min(sc.startLine, n - 1));
    const hi = Math.max(lo, Math.min(sc.endLine, n - 1));
    for (let i = lo; i <= hi; i++) covered[i] = 1;
  }
  let missingLineCount = 0;
  for (let i = 0; i < n; i++) {
    if (!covered[i]) missingLineCount++;
  }

  if (missingLineCount > 0) {
    return { ok: false, missingLineCount };
  }

  const original = normalizeSrtConcatenatedText(
    blocks.map((b) => b.text).join(" "),
  );
  const reconstructed = normalizeSrtConcatenatedText(
    scenes.map((s) => s.text).join(" "),
  );
  return { ok: original === reconstructed, missingLineCount: 0 };
}

/** Sau khi gom clip/phút: tách lại mọi scene vượt quá max duration của zone. */
function splitOversizedVisualScenes(
  scenes: VisualSceneDraft[],
  blocks: SubtitleBlock[],
  pacing: PacingProfile,
): VisualSceneDraft[] {
  if (!scenes.length) return [];
  const timelineOff = blocks[0]?.startTime ?? 0;
  const totalDur = Math.max(
    0.05,
    blocks[blocks.length - 1].endTime - timelineOff,
  );
  const out: VisualSceneDraft[] = [];
  for (const sc of scenes) {
    const relT = sc.startTime - timelineOff;
    const zone = pacingZoneAtTime(relT, totalDur, pacing);
    const [, maxDm] = sceneDurationBounds(zone, pacing);
    if (sc.durationSec <= maxDm * 1.08) {
      out.push(
        rebuildVisualSceneFromBlockRange(
          sc,
          blocks,
          sc.startLine,
          sc.endLine,
          pacing,
        ),
      );
      continue;
    }
    const parts = splitBlockRangeIntoVisualScenes(
      blocks,
      sc.startLine,
      sc.endLine,
      pacing,
      null,
    );
    if (parts.length > 0) {
      for (const part of parts) {
        out.push(
          rebuildVisualSceneFromBlockRange(
            part,
            blocks,
            part.startLine,
            part.endLine,
            pacing,
          ),
        );
      }
    } else {
      out.push(
        rebuildVisualSceneFromBlockRange(
          sc,
          blocks,
          sc.startLine,
          sc.endLine,
          pacing,
        ),
      );
    }
  }
  return out;
}

export function mergeMeaningBeatsToVisualScenes(
  beats: MeaningBeat[],
  blocks: SubtitleBlock[],
  pacing: PacingProfile,
): VisualSceneDraft[] {
  if (!blocks.length) return [];
  const prepared = prepareMeaningBeats(beats, blocks.length);
  const timelineOff = blocks[0].startTime;
  const totalDur = Math.max(0.05, blocks[blocks.length - 1].endTime - timelineOff);

  const scenes: VisualSceneDraft[] = [];
  let i = 0;
  while (i < prepared.length) {
    const first = prepared[i];
    let gStart = first.start_line_index;
    let gEnd = first.end_line_index;
    let group = [first];
    let startTime = blocks[gStart].startTime;
    let endTime = blocks[gEnd].endTime;

    let j = i + 1;
    while (j < prepared.length) {
      const next = prepared[j];
      if (next.start_line_index !== gEnd + 1) break;

      const mergeStart = gStart;
      const mergeEnd = next.end_line_index;
      const mt0 = blocks[mergeStart].startTime;
      const mt1 = blocks[mergeEnd].endTime;
      const mergeDur = mt1 - mt0;
      const relT = mt0 - timelineOff;
      const mergeZone = pacingZoneAtTime(relT, totalDur, pacing);
      const [, maxDm] = sceneDurationBounds(mergeZone, pacing);

      const beatsOk = group.length + 1 <= maxBeatsPerZone(mergeZone);
      const topicOk = topicsCompatible(group[group.length - 1].topic, next.topic);
      const importanceBreak =
        mergeZone === "hook" &&
        next.importance >= 5 &&
        mergeDur > (maxDm + pacing.hookSceneMinSec) / 2;

      if (mergeDur <= maxDm && topicOk && beatsOk && !importanceBreak) {
        group.push(next);
        gEnd = mergeEnd;
        endTime = mt1;
        j++;
        continue;
      }
      break;
    }

    const relStart = startTime - timelineOff;
    const zone = pacingZoneAtTime(relStart, totalDur, pacing);
    const text = blocks
      .slice(gStart, gEnd + 1)
      .map((b) => b.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const summaryVi =
      group.map((g) => g.summary_vi).filter(Boolean).join(" · ") ||
      text.slice(0, 200);
    const visualHintsEn = group.map((g) => g.suggested_visual_direction_en).filter(Boolean);

    scenes.push({
      startLine: gStart,
      endLine: gEnd,
      startTime,
      endTime,
      durationSec: endTime - startTime,
      text,
      summaryVi,
      pacingZone: zone,
      topics: group.map((g) => g.topic),
      visualHintsEn,
    });
    i = j;
  }

  const budget = totalClipBudget(totalDur, pacing);
  let pipeline = compressScenesIfNeeded(scenes, blocks, pacing, budget.max);
  pipeline = enforceMaxClipsPerMinute(pipeline, blocks, pacing);
  pipeline = compressScenesIfNeeded(pipeline, blocks, pacing, budget.max);
  let split = splitOversizedVisualScenes(pipeline, blocks, pacing);

  const oneCoversAll =
    split.length === 1 &&
    split[0].startLine === 0 &&
    split[0].endLine === blocks.length - 1 &&
    blocks.length >= 2;

  if (oneCoversAll) {
    const d = split[0].durationSec;
    const zoneMax = Math.max(
      pacing.hookSceneMaxSec,
      pacing.bodySceneMaxSec,
      pacing.endingSceneMaxSec,
    );
    const manyLines = blocks.length >= 6;
    const tooLongForOne = d > zoneMax * 0.65;
    if (tooLongForOne || manyLines) {
      const targetScenes = Math.min(
        budget.max,
        Math.max(budget.min, Math.ceil(blocks.length / 3)),
      );
      const forcedCap = Math.min(
        pacing.bodySceneMaxSec,
        Math.max(
          pacing.hookSceneMinSec * 1.5,
          targetScenes > 0 ? (d / targetScenes) * 1.05 : pacing.bodySceneMaxSec,
        ),
      );
      split = splitBlockRangeIntoVisualScenes(
        blocks,
        0,
        blocks.length - 1,
        pacing,
        forcedCap,
      );
    }
  }

  let finalScenes = enforceTotalClipBudget(
    split.length > 0 ? split : pipeline,
    blocks,
    pacing,
    budget,
  );

  if (!finalScenes.length) finalScenes = pipeline;

  return repairVisualSceneLineCoverage(finalScenes, blocks, pacing, budget);
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Giới hạn narration trong prompt keywords — đủ ngữ cảnh, giảm prompt token. */
function truncateForPrompt(text: string, max = 320): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Heuristic ngôn ngữ phụ đề — gợi ý cho prompt Gemini. */
export function detectSubtitleLangHint(
  lines: { text: string }[],
): string {
  const sample = lines
    .slice(0, 24)
    .map((l) => l.text)
    .join(" ")
    .toLowerCase();
  if (/[äöüß]/.test(sample) || /\b(und|der|die|das|ist|nicht|wir|sie)\b/.test(sample)) {
    return "de";
  }
  if (/[àâçéèêëîïôùûüœ]/i.test(sample) || /\b(les|des|une|dans|pour|avec)\b/.test(sample)) {
    return "fr";
  }
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(sample)) {
    return "vi";
  }
  if (/\b(the|and|with|from|this|that|have|been)\b/.test(sample)) return "en";
  return "auto";
}

const GENERIC_KEYWORD_RE =
  /^(b-?roll(\s+footage)?|stock\s+(video\s+)?b-?roll|documentary\s+b-?roll|generic\s+contextual\s+footage|relevant\s+stock\s+b-?roll)$/i;

const GENERIC_VISUAL_HINT_RE =
  /^(generic|relevant\s+stock|b-?roll|footage|contextual)/i;

export function isGenericStockKeyword(k: string): boolean {
  const t = k.trim();
  if (t.length < 2) return true;
  return GENERIC_KEYWORD_RE.test(t);
}

/** Gom beat theo nhóm câu khi Gemini meaning-beats thất bại. */
export function ruleBasedMeaningBeats(
  blocks: SubtitleBlock[],
  maxSentencesPerBeat = 2,
): MeaningBeat[] {
  if (!blocks.length) return [];
  const beats: MeaningBeat[] = [];
  const span = Math.max(1, maxSentencesPerBeat);
  for (let i = 0; i < blocks.length; ) {
    const end = Math.min(blocks.length - 1, i + span - 1);
    const text = blocks
      .slice(i, end + 1)
      .map((b) => b.text)
      .join(" ");
    beats.push({
      start_line_index: i,
      end_line_index: end,
      summary_vi: text.slice(0, 160),
      topic: "",
      importance: 3,
      suggested_visual_direction_en: "",
    });
    i = end + 1;
  }
  return beats;
}

export function buildMeaningBeatsPrompt(
  lines: { index: number; text: string; start_sec: number; end_sec: number }[],
  visualStyleUserNotes: string,
  langHint = "auto",
): string {
  const style = (visualStyleUserNotes || "").trim();
  const lastIdx = lines.length - 1;
  const langLine =
    langHint === "de"
      ? "Input is GERMAN subtitles — read German, but topic and suggested_visual_direction_en MUST be English stock-search phrases."
      : langHint === "fr"
        ? "Input is FRENCH subtitles — read French, but topic and suggested_visual_direction_en MUST be English."
        : langHint === "vi"
          ? "Input may be Vietnamese — summary may be Vietnamese; topic and suggested_visual_direction_en MUST be English."
          : "Subtitles may be ANY language (German, English, Vietnamese, etc.). Understand meaning in the source language.";

  return `SRT analyst. Each row is one COMPLETE SENTENCE (SRT soft line breaks were merged; do NOT treat newline as sentence end). Group 0-based sentence indices into meaning beats. JSON only, no prose.
${langLine}

Each beat:
- start_line_index, end_line_index (0..${lastIdx}) — inclusive sentence indices
- summary_vi: short Vietnamese summary of beat content (translate if source is not Vietnamese)
- topic: REQUIRED 2-4 English words for stock video search (specific, not "general" or "b-roll")
- importance: 1-5
- suggested_visual_direction_en: REQUIRED short English shot idea (specific subject + action)

Rules: cover every sentence index once, no gaps/overlaps; NEVER split a single sentence across two beats; never one beat for entire file if >5 sentences or >25s; merge only related consecutive sentences; split on topic/visual shift; first ~60s prefer smaller beats; each beat needs DISTINCT English topic when ideas differ.
Style hint: ${style || "none"}

Sentences:${compactJson(lines)}

{"meaning_beats":[{"start_line_index":0,"end_line_index":0,"summary_vi":"","topic":"","importance":3,"suggested_visual_direction_en":""}]}`;
}

export function buildSceneKeywordsPrompt(
  drafts: VisualSceneDraft[],
  visualStyleUserNotes: string,
  langHint = "auto",
): string {
  const style = (visualStyleUserNotes || "").trim();
  const payload = drafts.map((d, idx) => ({
    scene_index: idx,
    pacing_zone: d.pacingZone,
    duration_sec: Math.round(d.durationSec * 10) / 10,
    narration: truncateForPrompt(d.text),
    summary_vi: d.summaryVi.slice(0, 160),
    topics: d.topics.slice(0, 4),
    visual_hints_en: d.visualHintsEn.slice(0, 3),
  }));

  const langNote =
    langHint === "de"
      ? "Narration is GERMAN — understand German meaning, output English Storyblocks queries only."
      : "Narration may be non-English — understand full meaning, output English Storyblocks queries only.";

  return `Stock-footage keyword planner. JSON only. ${langNote}

Each scene needs UNIQUE English keywords (2-5 words) matching THAT scene's narration — never repeat the same generic phrase (e.g. "b-roll footage") for every scene.
Use topics/visual_hints_en when present; otherwise infer from narration.
Not literal word-for-word translation — pick concrete visuals (who/what/where/action).

Style: ${style || "none"}

Per scene (exact counts): keywords×3, fallback_keywords×2, storyblocks_search_queries×3.

Scenes:${compactJson(payload)}

{"scenes":[{"scene_index":0,"keywords":[],"fallback_keywords":[],"storyblocks_search_queries":[]}]}`;
}

/** Prompt batch: dịch / tóm tắt narration từng scene sang tiếng Việt cho editor. */
export function buildVietnameseSceneNotesPrompt(
  drafts: VisualSceneDraft[],
): string {
  const payload = drafts.map((d, idx) => ({
    scene_index: idx,
    narration: truncateForPrompt(d.text, 400),
    pacing_zone: d.pacingZone,
  }));

  return `Video editor assistant. JSON only.

For EACH scene write summary_vi in Vietnamese (1-2 natural sentences) explaining WHAT the narration is about — so a Vietnamese editor understands the scene without reading the original language.
Source narration may be German, English, Vietnamese, etc. Always output Vietnamese; do not leave foreign-language sentences.

Scenes:${compactJson(payload)}

{"scenes":[{"scene_index":0,"summary_vi":""}]}`;
}

export function parseVietnameseSceneNotes(
  raw: any,
  expectedCount: number,
  drafts: VisualSceneDraft[],
): string[] {
  let list: any[] = [];
  if (Array.isArray(raw?.scenes)) list = raw.scenes;
  else if (Array.isArray(raw)) list = raw;
  const out: string[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const row =
      list.find(
        (x) => typeof x?.scene_index === "number" && x.scene_index === i,
      ) ?? list[i];
    const vi =
      typeof row?.summary_vi === "string"
        ? row.summary_vi.trim()
        : typeof row?.summaryVi === "string"
          ? row.summaryVi.trim()
          : "";
    out.push(vi.length > 0 ? vi : (drafts[i]?.text.slice(0, 200) ?? ""));
  }
  return out;
}

/** Fallback keywords từ beat topics / visual hints / narration khi Gemini trả rỗng hoặc generic. */
export function keywordPlanFromDraft(
  draft: VisualSceneDraft,
  sceneIndex: number,
): SceneKeywordPlan {
  const hints = draft.visualHintsEn
    .map((h) => h.trim())
    .filter((h) => h.length > 3 && !GENERIC_VISUAL_HINT_RE.test(h));
  const topics = draft.topics
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && t.toLowerCase() !== "general");

  let keywords = uniqueEnglishList([...hints, ...topics], 3).filter(
    (k) => !isGenericStockKeyword(k),
  );

  if (keywords.length === 0) {
    const zoneLabel =
      draft.pacingZone === "hook"
        ? "dramatic opening"
        : draft.pacingZone === "ending"
          ? "closing conclusion"
          : "documentary";
    keywords = uniqueEnglishList(
      [
        `${zoneLabel} scene ${sceneIndex + 1}`,
        draft.pacingZone === "hook" ? "news intro footage" : "news report footage",
      ],
      3,
    );
  }

  const fallback_keywords = uniqueEnglishList(
    keywords.length > 1 ? keywords.slice(1) : ["documentary footage", "news b-roll"],
    2,
  );

  return {
    scene_index: sceneIndex,
    keywords,
    fallback_keywords,
    storyblocks_search_queries: keywords,
  };
}

export function buildKeywordPlansFromDrafts(
  drafts: VisualSceneDraft[],
): SceneKeywordPlan[] {
  return drafts.map((d, i) => keywordPlanFromDraft(d, i));
}

export function plansLookGeneric(plans: SceneKeywordPlan[]): boolean {
  if (!plans.length) return true;
  const primaries = plans.map(
    (p) =>
      (p.storyblocks_search_queries[0] || p.keywords[0] || "").toLowerCase().trim(),
  );
  if (primaries.every((k) => isGenericStockKeyword(k))) return true;
  const uniq = new Set(primaries.filter(Boolean));
  return uniq.size === 1 && isGenericStockKeyword(primaries[0] || "");
}

export function mergeKeywordPlansWithDrafts(
  aiPlans: SceneKeywordPlan[],
  drafts: VisualSceneDraft[],
): SceneKeywordPlan[] {
  return drafts.map((draft, i) => {
    const ai = aiPlans[i];
    const draftPlan = keywordPlanFromDraft(draft, i);
    if (!ai) return draftPlan;

    const keywords = uniqueEnglishList(ai.keywords, 3).filter(
      (k) => !isGenericStockKeyword(k),
    );
    const queries = uniqueEnglishList(ai.storyblocks_search_queries, 3).filter(
      (k) => !isGenericStockKeyword(k),
    );

    if (keywords.length === 0 && queries.length === 0) return draftPlan;

    return {
      scene_index: i,
      keywords: keywords.length ? keywords : queries.slice(0, 3),
      fallback_keywords:
        uniqueEnglishList(ai.fallback_keywords, 2).filter(
          (k) => !isGenericStockKeyword(k),
        ).length > 0
          ? uniqueEnglishList(ai.fallback_keywords, 2)
          : draftPlan.fallback_keywords,
      storyblocks_search_queries:
        queries.length > 0 ? queries : keywords.length ? keywords : draftPlan.storyblocks_search_queries,
    };
  });
}

export function parseKeywordPlans(
  raw: any,
  expectedCount: number,
  drafts?: VisualSceneDraft[],
): SceneKeywordPlan[] {
  let list: any[] = [];
  if (Array.isArray(raw?.scenes)) list = raw.scenes;
  else if (Array.isArray(raw)) list = raw;
  const out: SceneKeywordPlan[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const row = list.find(
      (x) => typeof x?.scene_index === "number" && x.scene_index === i,
    ) ?? list[i];
    let keywords = uniqueEnglishList(row?.keywords, 3).filter(
      (k) => !isGenericStockKeyword(k),
    );
    let fallback_keywords = uniqueEnglishList(row?.fallback_keywords, 2).filter(
      (k) => !isGenericStockKeyword(k),
    );
    let storyblocks_search_queries = uniqueEnglishList(
      row?.storyblocks_search_queries,
      3,
    ).filter((k) => !isGenericStockKeyword(k));

    if (
      (keywords.length === 0 || storyblocks_search_queries.length === 0) &&
      drafts?.[i]
    ) {
      const fromDraft = keywordPlanFromDraft(drafts[i], i);
      if (keywords.length === 0) keywords = fromDraft.keywords;
      if (fallback_keywords.length === 0) fallback_keywords = fromDraft.fallback_keywords;
      if (storyblocks_search_queries.length === 0) {
        storyblocks_search_queries = fromDraft.storyblocks_search_queries;
      }
    }

    if (keywords.length === 0) {
      keywords =
        storyblocks_search_queries.length > 0
          ? storyblocks_search_queries.slice(0, 3)
          : drafts?.[i]
            ? keywordPlanFromDraft(drafts[i], i).keywords
            : ["documentary news footage"];
    }

    out.push({
      scene_index: i,
      keywords,
      fallback_keywords:
        fallback_keywords.length > 0
          ? fallback_keywords
          : keywords.length > 1
            ? keywords.slice(1, 3)
            : ["documentary footage"],
      storyblocks_search_queries:
        storyblocks_search_queries.length > 0
          ? storyblocks_search_queries
          : keywords,
    });
  }
  return out;
}

function uniqueEnglishList(val: any, max: number): string[] {
  if (!Array.isArray(val)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of val) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t.length < 2) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Số keyword EN hiển thị trên UI mỗi scene (Storyblocks). */
export const STORYBLOCKS_KEYWORDS_UI_LIMIT = 4;

/** Lấy tối đa N keyword EN phù hợp nhất để hiển thị / tìm Storyblocks. */
export function topStoryblocksKeywordsForScene(
  ctx:
    | {
        keywords?: string[];
        fallbackKeywords?: string[];
        storyblocksSearchQueries?: string[];
      }
    | undefined,
  primaryKeyword?: string,
  limit = STORYBLOCKS_KEYWORDS_UI_LIMIT,
): string[] {
  const ordered = [
    ...(ctx?.storyblocksSearchQueries || []),
    ...(ctx?.keywords || []),
    ...(ctx?.fallbackKeywords || []),
  ];

  const seen = new Set<string>();
  const out: string[] = [];

  const tryAdd = (raw: string, allowGeneric = false) => {
    const k = raw.trim();
    if (k.length < 2) return;
    const key = k.toLowerCase();
    if (seen.has(key)) return;
    if (!allowGeneric && isGenericStockKeyword(k)) return;
    seen.add(key);
    out.push(k);
  };

  if (primaryKeyword?.trim()) {
    tryAdd(primaryKeyword);
  }

  for (const k of ordered) {
    if (out.length >= limit) break;
    tryAdd(k);
  }

  if (out.length < limit) {
    for (const k of ordered) {
      if (out.length >= limit) break;
      tryAdd(k, true);
    }
  }

  return out.slice(0, limit);
}

export interface StockVideoLike {
  title?: string;
  duration?: number;
}

export function rankStockVideos(
  videos: StockVideoLike[],
  targetSceneSec: number,
): { order: number[]; filtered: StockVideoLike[] } {
  const indexed = videos.map((v, idx) => ({ v, idx }));
  indexed.sort((a, b) => {
    const da = a.v.duration ?? 10;
    const db = b.v.duration ?? 10;
    const ca = Math.abs(da - targetSceneSec);
    const cb = Math.abs(db - targetSceneSec);
    if (ca !== cb) return ca - cb;
    return db - da;
  });

  const order = indexed.map((x) => x.idx);
  const filtered = indexed.map((x) => x.v);
  return { order, filtered };
}

/** SRT timestamp → giây (00:00:20,000). */
export function parseSrtTimestampToSeconds(timeStr: string): number {
  if (!timeStr) return 0;
  const parts = timeStr.replace(",", ".").split(":");
  if (parts.length < 3) return 0;
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);
  return h * 3600 + m * 60 + s;
}

export function formatSecondsToSrtTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")},${ms.toString().padStart(3, "0")}`;
}

export interface EditorSceneSrtContext {
  startTime?: string;
  endTime?: string;
  duration?: number;
  keywords?: string[];
  fallbackKeywords?: string[];
  storyblocksSearchQueries?: string[];
  summaryVi?: string;
  pacingZone?: "hook" | "body" | "ending";
}

export interface EditorSceneLike {
  id: number;
  text: string;
  keyword: string;
  videos: unknown[];
  selectedVideoIdx: number;
  selectedVideos: unknown[];
  loadingVideos?: boolean;
  srtContext?: EditorSceneSrtContext;
  mergedFromIds?: number[];
  isMerged?: boolean;
}

/** Chuyển scene editor → draft để gọi Gemini keywords. */
export function visualDraftFromEditorScene(
  scene: EditorSceneLike,
  sceneIndex: number,
): VisualSceneDraft {
  const dur =
    scene.srtContext?.duration ??
    Math.max(3, Math.ceil(scene.text.trim().split(/\s+/).length / 2.5));
  const hintSrc = [
    ...(scene.srtContext?.storyblocksSearchQueries || []),
    ...(scene.srtContext?.keywords || []),
    scene.keyword,
  ];
  const topics = (scene.srtContext?.keywords || [])
    .map((k) => k.trim())
    .filter((k) => k.length > 2 && !isGenericStockKeyword(k))
    .slice(0, 4);
  const visualHintsEn = hintSrc
    .map((k) => k.trim())
    .filter((k) => k.length > 3 && !isGenericStockKeyword(k))
    .slice(0, 3);

  return {
    startLine: sceneIndex,
    endLine: sceneIndex,
    startTime: 0,
    endTime: dur,
    durationSec: dur,
    text: scene.text,
    summaryVi:
      scene.srtContext?.summaryVi?.trim() || scene.text.slice(0, 200),
    pacingZone: scene.srtContext?.pacingZone || "body",
    topics,
    visualHintsEn,
  };
}

/** Gộp nhiều scene (theo index) thành một; xóa các scene còn lại và đánh số lại id. */
export function mergeEditorScenesAtIndices<T extends EditorSceneLike>(
  scenes: T[],
  indices: number[],
): T[] {
  const unique = [...new Set(indices)].filter(
    (i) => Number.isInteger(i) && i >= 0 && i < scenes.length,
  );
  if (unique.length < 2) return scenes;

  const sorted = [...unique].sort((a, b) => a - b);
  const parts = sorted.map((i) => scenes[i]);

  const mergedText = parts
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join(" ");

  const ctx0 = parts[0].srtContext;
  const ctxN = parts[parts.length - 1].srtContext;

  let duration = parts.reduce(
    (sum, p) => sum + (p.srtContext?.duration ?? 0),
    0,
  );
  const startTime = ctx0?.startTime || "00:00:00,000";
  const endTime = ctxN?.endTime || ctx0?.endTime || startTime;

  if (ctx0?.startTime && ctxN?.endTime) {
    const startSec = parseSrtTimestampToSeconds(ctx0.startTime);
    const endSec = parseSrtTimestampToSeconds(ctxN.endTime);
    if (endSec > startSec) duration = endSec - startSec;
  }

  const summaryParts = parts
    .map((p) => p.srtContext?.summaryVi?.trim())
    .filter(Boolean);
  const summaryVi = summaryParts.length
    ? summaryParts.join(" · ").slice(0, 400)
    : mergedText.slice(0, 200);

  const mergedFromIds = parts.flatMap((p) =>
    p.mergedFromIds?.length ? p.mergedFromIds : [p.id],
  );

  const merged: T = {
    ...parts[0],
    text: mergedText,
    keyword: parts[0].keyword,
    videos: [],
    selectedVideoIdx: 0,
    selectedVideos: [],
    loadingVideos: false,
    isMerged: true,
    mergedFromIds,
    srtContext: {
      ...ctx0,
      startTime,
      endTime,
      duration,
      keywords: [],
      fallbackKeywords: [],
      storyblocksSearchQueries: [],
      summaryVi,
      pacingZone: ctx0?.pacingZone || "body",
    },
  };

  const result: T[] = [];
  for (let i = 0; i < scenes.length; i++) {
    if (i === sorted[0]) {
      result.push(merged);
    } else if (!sorted.includes(i)) {
      result.push(scenes[i]);
    }
  }

  return result.map((s, i) => ({ ...s, id: i + 1 }));
}

export function primaryKeywordFromPlan(plan: SceneKeywordPlan): string {
  return (
    plan.storyblocks_search_queries[0] ||
    plan.keywords[0] ||
    "stock video b-roll"
  );
}

export function blocksToSubtitleBlocks(
  blocks: { startTime: number; endTime: number; text: string }[],
): SubtitleBlock[] {
  return blocks.map((b, lineIndex) => ({
    lineIndex,
    startTime: b.startTime,
    endTime: b.endTime,
    text: b.text,
  }));
}

type SentenceAccumMeta = {
  sourceStart: number;
  sourceEnd: number;
  startTime: number;
  endTime: number;
};

/**
 * Gom cue SRT thành câu hoàn chỉnh (theo dấu câu), giữ timecode:
 * bắt đầu = cue đầu của câu, kết thúc = cue cuối của câu.
 */
export function aggregateSubtitleBlocksIntoSentences(
  cues: SubtitleBlock[],
): SubtitleBlock[] {
  if (!cues.length) return [];

  const sentences: SubtitleBlock[] = [];
  let pending = "";
  let acc: SentenceAccumMeta | null = null;

  const pushSentence = (raw: string, meta: SentenceAccumMeta) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return;
    sentences.push({
      lineIndex: sentences.length,
      startTime: meta.startTime,
      endTime: meta.endTime,
      text,
      sourceCueStart: meta.sourceStart,
      sourceCueEnd: meta.sourceEnd,
    });
  };

  for (let ci = 0; ci < cues.length; ci++) {
    const cue = cues[ci];
    const chunk = cue.text.replace(/\s+/g, " ").trim();
    if (!chunk) continue;

    if (!acc) {
      acc = {
        sourceStart: ci,
        sourceEnd: ci,
        startTime: cue.startTime,
        endTime: cue.endTime,
      };
      pending = chunk;
    } else {
      acc.sourceEnd = ci;
      acc.endTime = cue.endTime;
      pending = `${pending} ${chunk}`;
    }

    let guard = 0;
    while (pending && guard++ < 64) {
      const m = pending.match(COMPLETE_SENTENCE_HEAD_RE);
      if (!m) break;
      pushSentence(m[1], acc);
      pending = pending.slice(m[0].length).trim();
      if (pending) {
        acc = {
          sourceStart: ci,
          sourceEnd: ci,
          startTime: cue.startTime,
          endTime: cue.endTime,
        };
      } else {
        acc = null;
      }
    }
  }

  if (pending.trim() && acc) {
    pushSentence(pending, acc);
  }

  return sentences;
}

/** Giữ tổng duration các clip trong scene khớp `targetTotal` (đồng bộ SRT / voice-over). */
export function normalizeSceneSelectedVideos(
  segments:
    | { videoIdx: number; startTimeOffset: number; duration: number }[]
    | undefined,
  selectedVideoIdx: number,
  targetTotal: number,
): { videoIdx: number; startTimeOffset: number; duration: number }[] {
  const t = Math.max(0.5, targetTotal);
  let segs =
    segments && segments.length > 0
      ? segments.map((s) => ({ ...s }))
      : [{ videoIdx: selectedVideoIdx, startTimeOffset: 0, duration: t }];
  const sum = segs.reduce((a, s) => a + s.duration, 0);
  if (Math.abs(sum - t) < 0.05) {
    let off = 0;
    return segs.map((s) => {
      const r = { ...s, startTimeOffset: off };
      off += s.duration;
      return r;
    });
  }
  if (segs.length === 1) {
    return [{ ...segs[0], duration: t, startTimeOffset: 0 }];
  }
  const scale = t / Math.max(sum, 0.001);
  const next = segs.map((s) => ({
    ...s,
    duration: Math.max(0.5, Math.round(s.duration * scale * 20) / 20),
  }));
  const newSum = next.reduce((a, s) => a + s.duration, 0);
  next[next.length - 1].duration = Math.max(
    0.5,
    Math.round((next[next.length - 1].duration + (t - newSum)) * 20) / 20,
  );
  let off = 0;
  return next.map((s) => {
    const r = { ...s, startTimeOffset: off };
    off += s.duration;
    return r;
  });
}
