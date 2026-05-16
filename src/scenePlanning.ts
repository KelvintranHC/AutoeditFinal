/**
 * Scene Planning Engine: meaning beats (AI) + rule-based visual scenes + keyword batch (AI).
 */

export interface SubtitleBlock {
  lineIndex: number;
  startTime: number;
  endTime: number;
  text: string;
}

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
  avoid_terms: string[];
  storyblocks_search_queries: string[];
  summary_vi_note: string;
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

function targetMaxScenes(totalSec: number, p: PacingProfile): number {
  const capMid = Math.round(
    (p.maxTotalClips10MinMin + p.maxTotalClips10MinMax) / 2,
  );
  const ratio = Math.min(1, Math.max(0, totalSec / 600));
  const blended = Math.round(ratio * capMid + (1 - ratio) * Math.min(20, capMid * 0.45));
  return Math.max(6, blended);
}

function compressScenesIfNeeded(
  scenes: VisualSceneDraft[],
  blocks: SubtitleBlock[],
  p: PacingProfile,
  maxScenes: number,
): VisualSceneDraft[] {
  let s = [...scenes];
  while (s.length > maxScenes && s.length >= 2) {
    let bestK = -1;
    let bestScore = Infinity;
    for (let k = 0; k < s.length - 1; k++) {
      const a = s[k];
      const b = s[k + 1];
      const mergedDur = b.endTime - a.startTime;
      if (mergedDur > Math.max(p.bodySceneMaxSec * 2, 42)) continue;
      if (mergedDur < bestScore) {
        bestScore = mergedDur;
        bestK = k;
      }
    }
    if (bestK < 0) break;
    const a = s[bestK];
    const b = s[bestK + 1];
    const timelineOff = blocks[0]?.startTime ?? 0;
    const totalDur = Math.max(
      0.05,
      blocks[blocks.length - 1].endTime - timelineOff,
    );
    const z = pacingZoneAtTime(a.startTime - timelineOff, totalDur, p);
    const merged: VisualSceneDraft = {
      startLine: a.startLine,
      endLine: b.endLine,
      startTime: a.startTime,
      endTime: b.endTime,
      durationSec: b.endTime - a.startTime,
      text: blocks
        .slice(a.startLine, b.endLine + 1)
        .map((x) => x.text)
        .join(" "),
      summaryVi: [a.summaryVi, b.summaryVi].filter(Boolean).join(" · "),
      pacingZone: z,
      topics: [...a.topics, ...b.topics],
      visualHintsEn: [...a.visualHintsEn, ...b.visualHintsEn],
    };
    s.splice(bestK, 2, merged);
  }
  return s;
}

function mergeAdjacentVisualScenes(
  a: VisualSceneDraft,
  b: VisualSceneDraft,
  blocks: SubtitleBlock[],
  timelineOff: number,
  totalDur: number,
  p: PacingProfile,
): VisualSceneDraft {
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
      .join(" "),
    summaryVi: [a.summaryVi, b.summaryVi].filter(Boolean).join(" · "),
    pacingZone: z,
    topics: [...a.topics, ...b.topics],
    visualHintsEn: [...a.visualHintsEn, ...b.visualHintsEn],
  };
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
      .join(" ");
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
      out.push(sc);
      continue;
    }
    const parts = splitBlockRangeIntoVisualScenes(
      blocks,
      sc.startLine,
      sc.endLine,
      pacing,
      null,
    );
    if (parts.length > 0) out.push(...parts);
    else out.push(sc);
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
      .join(" ");
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

  const maxScenes = targetMaxScenes(totalDur, pacing);
  const compressed = compressScenesIfNeeded(scenes, blocks, pacing, maxScenes);
  const enforced = enforceMaxClipsPerMinute(compressed, blocks, pacing);
  let split = splitOversizedVisualScenes(enforced, blocks, pacing);

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
        32,
        Math.max(2, Math.ceil(blocks.length / 3)),
      );
      const forcedCap = Math.min(
        pacing.bodySceneMaxSec,
        Math.max(
          pacing.hookSceneMinSec * 1.5,
          (d / targetScenes) * 1.05,
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

  return split.length > 0 ? split : enforced;
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

export function buildMeaningBeatsPrompt(
  lines: { index: number; text: string; start_sec: number; end_sec: number }[],
  visualStyleUserNotes: string,
): string {
  const style = (visualStyleUserNotes || "").trim();
  const lastIdx = lines.length - 1;
  return `SRT analyst. Group 0-based lines into meaning beats. JSON only, no prose.

Each beat: start_line_index, end_line_index (0..${lastIdx}), summary_vi (short VI), topic (2-4 EN words), importance (1-5), suggested_visual_direction_en (short EN shot idea).

Rules: cover every line once, no gaps/overlaps; do not use one beat for the whole file if >5 lines or duration >25s; merge only same idea; split on topic/visual shift; first ~60s prefer smaller beats.
Style hint: ${style || "none"}

Lines:${compactJson(lines)}

{"meaning_beats":[{"start_line_index":0,"end_line_index":0,"summary_vi":"","topic":"","importance":3,"suggested_visual_direction_en":""}]}`;
}

export function buildSceneKeywordsPrompt(
  drafts: VisualSceneDraft[],
  visualStyleUserNotes: string,
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

  return `Stock-footage keyword planner. JSON only. All search strings in English (2-5 words each), natural for Storyblocks — not literal VI translation.

Style: ${style || "none"}

Per scene (exact counts): keywords×3, fallback_keywords×2, avoid_terms×4, storyblocks_search_queries×3, summary_vi_note (short VI).

Scenes:${compactJson(payload)}

{"scenes":[{"scene_index":0,"keywords":[],"fallback_keywords":[],"avoid_terms":[],"storyblocks_search_queries":[],"summary_vi_note":""}]}`;
}

export function parseKeywordPlans(
  raw: any,
  expectedCount: number,
): SceneKeywordPlan[] {
  let list: any[] = [];
  if (Array.isArray(raw?.scenes)) list = raw.scenes;
  else if (Array.isArray(raw)) list = raw;
  const out: SceneKeywordPlan[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const row = list.find(
      (x) => typeof x?.scene_index === "number" && x.scene_index === i,
    ) ?? list[i];
    const keywords = uniqueEnglishList(row?.keywords, 3);
    const fallback_keywords = uniqueEnglishList(row?.fallback_keywords, 2);
    const avoid_terms = uniqueEnglishList(row?.avoid_terms, 4);
    const storyblocks_search_queries = uniqueEnglishList(
      row?.storyblocks_search_queries,
      3,
    );
    const summary_vi_note =
      typeof row?.summary_vi_note === "string"
        ? row.summary_vi_note
        : typeof row?.summaryViNote === "string"
          ? row.summaryViNote
          : "";
    out.push({
      scene_index: i,
      keywords: keywords.length ? keywords : ["b-roll footage"],
      fallback_keywords:
        fallback_keywords.length > 0
          ? fallback_keywords
          : ["documentary b-roll"],
      avoid_terms,
      storyblocks_search_queries:
        storyblocks_search_queries.length > 0
          ? storyblocks_search_queries
          : keywords,
      summary_vi_note,
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

export interface StockVideoLike {
  title?: string;
  duration?: number;
}

export function rankStockVideos(
  videos: StockVideoLike[],
  targetSceneSec: number,
  avoidTerms: string[],
): { order: number[]; filtered: StockVideoLike[] } {
  const low = avoidTerms.map((t) => t.toLowerCase()).filter((t) => t.length > 2);
  const penalty = (title: string) => {
    const tl = title.toLowerCase();
    return low.reduce((acc, term) => (tl.includes(term) ? acc + 1 : acc), 0);
  };

  const indexed = videos.map((v, idx) => ({ v, idx }));
  indexed.sort((a, b) => {
    const pa = penalty(a.v.title || "");
    const pb = penalty(b.v.title || "");
    if (pa !== pb) return pa - pb;
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
