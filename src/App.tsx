/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import {
  Loader2,
  Plus,
  Play,
  Info,
  Search,
  SendHorizontal,
  LayoutGrid,
  MonitorPlay,
  Download,
  Folder,
  FolderOpen,
  LogOut,
  Trash2,
  FileText,
  Save,
  Settings,
  X,
  Cpu,
  CreditCard,
  Activity,
  DownloadCloud,
  Palette,
  GitMerge,
  Sparkles,
} from "lucide-react";
import * as motion from "motion/react-client";
import { GoogleGenAI, Type } from "@google/genai";
import axios from "axios";

import { db, handleFirestoreError, OperationType } from "./lib/firebase";
import {
  collection,
  doc,
  query,
  where,
  onSnapshot,
  setDoc,
  deleteDoc,
  serverTimestamp,
  updateDoc,
  getDocs,
  orderBy,
} from "firebase/firestore";
import { Toaster, toast } from "react-hot-toast";

// Global variables managed in component

import { AutomationDownloader } from "./components/AutomationDownloader";
import {
  DEFAULT_PACING_PROFILE,
  PACING_TOTAL_CLIPS_ABSOLUTE_MAX,
  PACING_TOTAL_CLIPS_ABSOLUTE_MIN,
  clampTotalClipsRange,
  normalizePacingProfile,
  type PacingProfile,
  blocksToSubtitleBlocks,
  buildMeaningBeatsPrompt,
  buildSceneKeywordsPrompt,
  buildVietnameseSceneNotesPrompt,
  detectSubtitleLangHint,
  parseVietnameseSceneNotes,
  mergeKeywordPlansWithDrafts,
  mergeMeaningBeatsToVisualScenes,
  normalizeSceneSelectedVideos,
  parseKeywordPlans,
  plansLookGeneric,
  rankStockVideos,
  ruleBasedMeaningBeats,
  mergeEditorScenesAtIndices,
  visualDraftFromEditorScene,
  primaryKeywordFromPlan,
  validateSrtSceneTextIntegrity,
  topStoryblocksKeywordsForScene,
} from "./scenePlanning";
import { buildGeminiJsonConfig } from "./geminiConfig";
import {
  APP_NAME,
  APP_VERSION,
  getAppFullLabel,
  getAppUpdateLabel,
  getAppVersionTitle,
} from "./appInfo";
import {
  createProjectApi,
  deleteProjectApi,
  fetchProjects,
  fetchUserConfig,
  migrateProjectsApi,
  saveUserConfigApi,
  updateProjectApi,
} from "./lib/projectApi";
import {
  type Project,
  type UserAppConfig,
  formatProjectCreatedAtVi,
  resolveProjectStatus,
  LEGACY_CONFIG_STORAGE_KEY,
  LEGACY_PROJECTS_STORAGE_KEY,
} from "./lib/projectTypes";
import {
  clearAppSession,
  loadAppSession,
  loginApp,
  verifyAppSession,
} from "./lib/appSession";
import { AppLoginScreen } from "./components/AppLoginScreen";

/** AI Studio: gemini-2.0-flash trả 404 với key/user mới — dùng 2.5.x làm mặc định. */
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

function migrateGeminiModelId(id: string | undefined | null): string {
  if (!id || typeof id !== "string" || !id.trim()) return DEFAULT_GEMINI_MODEL;
  const legacy: Record<string, string> = {
    "gemini-2.0-flash": DEFAULT_GEMINI_MODEL,
    "gemini-2.0-flash-001": DEFAULT_GEMINI_MODEL,
    "gemini-2.0-flash-exp": DEFAULT_GEMINI_MODEL,
  };
  const t = id.trim();
  return legacy[t] ?? t;
}

interface VideoResult {
  url: string;
  stockUrl: string;
  title: string;
  duration?: number; // Optional duration in seconds
  /** Sau khi tải HQ + upload Drive (server / SSE cập nhật). */
  driveLink?: string;
  driveFileId?: string;
}

interface ProxyLog {
  id: string;
  proxy: string;
  keyword: string;
  status: "success" | "error";
  timestamp: Date;
  message?: string;
  videosFound?: number;
}

interface SelectedVideo {
  videoIdx: number;
  startTimeOffset: number; // when this video starts within the scene
  duration: number; // how long to show this video
}

interface Scene {
  id: number;
  text: string;
  keyword: string;
  videos: VideoResult[];
  selectedVideoIdx: number; // Legacy, keep for compatibility
  selectedVideos: SelectedVideo[]; // List of videos making up this scene
  loadingVideos?: boolean;
  srtContext?: {
    startTime: string;
    endTime: string;
    duration: number; // Duration in seconds (endTime - startTime của cụm SRT)
    keywords: string[];
    fallbackKeywords?: string[];
    storyblocksSearchQueries?: string[];
    summaryVi?: string;
    pacingZone?: "hook" | "body" | "ending";
  };
  /** Scene được gộp thủ công từ nhiều scene gốc */
  isMerged?: boolean;
  mergedFromIds?: number[];
}

// Cache for storyblocks
const searchCache = new Map<string, any>();

function parseSRTTime(timeStr: string): number {
  if (!timeStr) return 0;
  // Format: 00:00:20,000
  const parts = timeStr.replace(",", ".").split(":");
  if (parts.length < 3) return 0;
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2].replace(",", "."));
  return h * 3600 + m * 60 + s;
}

function formatSRTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")},${ms.toString().padStart(3, "0")}`;
}

/** Hiển thị tổng thời lượng timeline (vd. «1 phút 30s», «45s»). */
function formatTimelineDurationVi(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec * 10) / 10);
  const mins = Math.floor(sec / 60);
  const rem = Math.round((sec % 60) * 10) / 10;
  const remLabel =
    rem % 1 === 0 ? `${Math.round(rem)}` : `${rem}`.replace(/\.0$/, "");
  if (mins <= 0) return `${remLabel}s`;
  if (rem < 0.05) return `${mins} phút`;
  return `${mins} phút ${remLabel}s`;
}

function computeTimelineTotalSeconds(scenes: Scene[]): number {
  let total = 0;
  for (const scene of scenes) {
    const hasVideos = scene.videos && scene.videos.length > 0;
    let segmentDurations: number[] = [];

    if (scene.selectedVideos && scene.selectedVideos.length > 0) {
      segmentDurations = scene.selectedVideos.map((seg) => seg.duration ?? 0);
    } else if (hasVideos) {
      segmentDurations = [scene.srtContext?.duration ?? 10];
    }

    if (segmentDurations.length > 0) {
      total += segmentDurations.reduce((sum, d) => sum + d, 0);
    } else if (scene.srtContext?.duration) {
      total += scene.srtContext.duration;
    }
  }
  return total;
}

function parseSRT(srt: string) {
  const blocks = [];
  const rawBlocks = srt.trim().split(/\r?\n\r?\n/);
  for (const rb of rawBlocks) {
    const lines = rb.split(/\r?\n/);
    if (lines.length >= 3) {
      const index = parseInt(lines[0].trim());
      const timeLine = lines[1];
      const match = timeLine.match(
        /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/,
      );
      if (match) {
        blocks.push({
          index,
          startTime: parseSRTTime(match[1]),
          endTime: parseSRTTime(match[2]),
          text: lines.slice(2).join(" ").trim(),
        });
      }
    }
  }
  return blocks;
}

function parseUsageMetadata(m: any) {
  return {
    promptTokenCount: m.promptTokenCount || 0,
    candidatesTokenCount: m.candidatesTokenCount || 0,
    totalTokenCount: m.totalTokenCount || 0,
    thoughtsTokenCount:
      m.candidatesTokenDetails?.thoughtsTokenCount || m.thoughtsTokenCount || 0,
    cachedContentTokenCount: m.cachedContentTokenCount || 0,
    toolUsePromptTokenCount:
      m.promptTokenDetails?.toolUsePromptTokenCount ||
      m.toolUsePromptTokenCount ||
      0,
  };
}

function TimelinePreview({
  scenes,
  setScenes,
  setIsDirty,
  audioUrl,
}: {
  scenes: Scene[];
  setScenes: React.Dispatch<React.SetStateAction<Scene[]>>;
  setIsDirty: (val: boolean) => void;
  audioUrl: string | null;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  // Sync audio playback with isPlaying
  useEffect(() => {
    if (!audioRef.current || !audioUrl) return;

    if (isPlaying) {
      // Start from beginning when master play starts
      audioRef.current.currentTime = 0;
      audioRef.current
        .play()
        .catch((e) => console.error("Audio playback failed:", e));
    } else {
      audioRef.current.pause();
    }
  }, [isPlaying, audioUrl]);
  const [currentSceneIdx, setCurrentSceneIdx] = useState(0);
  const [currentSegmentsIdx, setCurrentSegmentsIdx] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const videoRef = React.useRef<HTMLVideoElement>(null);

  const validScenes = scenes.filter((s) => s.videos && s.videos.length > 0);
  const totalPlayable = validScenes.length;
  const isReady = !scenes.some((s) => s.loadingVideos);
  const totalTimelineSec = React.useMemo(
    () => computeTimelineTotalSeconds(scenes),
    [scenes],
  );

  const currentPlayableScene = validScenes[currentSceneIdx];
  const currentSegment =
    currentPlayableScene?.selectedVideos?.[currentSegmentsIdx];

  const videoUrl = currentSegment
    ? currentPlayableScene?.videos[currentSegment.videoIdx]?.url ||
      currentPlayableScene?.videos[0]?.url
    : currentPlayableScene?.videos[currentPlayableScene?.selectedVideoIdx]
        ?.url || currentPlayableScene?.videos[0]?.url;

  const handleVideoEnded = () => {
    if (
      currentPlayableScene?.selectedVideos &&
      currentPlayableScene.selectedVideos.length > 0
    ) {
      if (currentSegmentsIdx < currentPlayableScene.selectedVideos.length - 1) {
        setCurrentSegmentsIdx((prev) => prev + 1);
        return;
      }
    }

    if (currentSceneIdx < validScenes.length - 1) {
      setCurrentSceneIdx((prev) => prev + 1);
      setCurrentSegmentsIdx(0);
    } else {
      setIsPlaying(false);
      setIsFullscreen(false);
      setCurrentSceneIdx(0); // reset to start
      setCurrentSegmentsIdx(0);
    }
  };

  const loopsCountRef = React.useRef(0);

  React.useEffect(() => {
    loopsCountRef.current = 0;
  }, [currentSceneIdx, currentSegmentsIdx]);

  // Logic to "cut" the video if its segment duration is reached
  // (Assuming we might want to switch early even if clip isn't done)
  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!currentSegment) return;
    const video = e.currentTarget;
    const dur = video.duration || 10;
    const totalCurrentTime = video.currentTime + (loopsCountRef.current * dur);
    if (totalCurrentTime >= currentSegment.duration) {
      handleVideoEnded();
    }
  };

  const handleVideoElementEnded = (e: React.SyntheticEvent<HTMLVideoElement>) => {
     if (!currentSegment) return;
     const video = e.currentTarget;
     const playedFor = video.duration || video.currentTime;
     const totalCurrentTime = playedFor + (loopsCountRef.current * playedFor);
     
     if (targetDurationCheck(totalCurrentTime, currentSegment.duration)) {
        loopsCountRef.current++;
        video.currentTime = 0;
        video.play().catch(console.error);
     } else {
        handleVideoEnded();
     }
  };
  
  const targetDurationCheck = (total: number, target: number) => {
      // give a tiny slice of 0.2s margin to prevent exact floating point false positives
      return total + 0.2 < target;
  };

  React.useEffect(() => {
    if (isPlaying && videoRef.current) {
      videoRef.current.play().catch((err) => {
        console.error("Auto-play next failed", err);
        setIsPlaying(false);
      });
    }
  }, [currentSceneIdx, currentSegmentsIdx, isPlaying, videoUrl]);

  const [draggedItem, setDraggedItem] = React.useState<{
    sIdx: number;
    segIdx: number;
  } | null>(null);

  const handleDragStart = (sIdx: number, segIdx: number) => {
    setDraggedItem({ sIdx, segIdx });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (targetSIdx: number, targetSegIdx: number) => {
    if (!draggedItem) return;
    const { sIdx: fromSIdx, segIdx: fromSegIdx } = draggedItem;

    const newScenes = [...scenes];
    const fromScene = { ...newScenes[fromSIdx] };
    const toScene =
      targetSIdx === fromSIdx ? fromScene : { ...newScenes[targetSIdx] };

    const [movedSeg] = fromScene.selectedVideos.splice(fromSegIdx, 1);

    // If moving within the same scene
    if (targetSIdx === fromSIdx) {
      fromScene.selectedVideos.splice(targetSegIdx, 0, movedSeg);
      newScenes[fromSIdx] = fromScene;
    } else {
      // Cross scene move
      toScene.selectedVideos.splice(targetSegIdx, 0, movedSeg);
      newScenes[fromSIdx] = fromScene;
      newScenes[targetSIdx] = toScene;
    }

    newScenes.forEach((s) => {
      const target = s.srtContext?.duration ?? 10;
      s.selectedVideos = normalizeSceneSelectedVideos(
        s.selectedVideos,
        s.selectedVideoIdx,
        target,
      );
    });

    setScenes(newScenes);
    setIsDirty(true);
    setDraggedItem(null);
  };

  const updateDuration = (sIdx: number, segIdx: number, delta: number) => {
    const newScenes = [...scenes];
    const scene = { ...newScenes[sIdx] };
    if (!scene.selectedVideos) return;
    const seg = { ...scene.selectedVideos[segIdx] };

    const target = scene.srtContext?.duration ?? 10;
    seg.duration = Math.max(0.5, seg.duration + delta);
    scene.selectedVideos[segIdx] = seg;
    scene.selectedVideos = normalizeSceneSelectedVideos(
      scene.selectedVideos,
      scene.selectedVideoIdx,
      target,
    );

    newScenes[sIdx] = scene;
    setScenes(newScenes);
    setIsDirty(true);
  };

  const removeSegment = (sIdx: number, segIdx: number) => {
    if (!scenes[sIdx].selectedVideos || scenes[sIdx].selectedVideos.length <= 1)
      return;
    const newScenes = [...scenes];
    const scene = { ...newScenes[sIdx] };
    scene.selectedVideos.splice(segIdx, 1);
    scene.selectedVideos = normalizeSceneSelectedVideos(
      scene.selectedVideos,
      scene.selectedVideoIdx,
      scene.srtContext?.duration ?? 10,
    );

    newScenes[sIdx] = scene;
    setScenes(newScenes);
    setIsDirty(true);
  };

  return (
    <>
      {audioUrl && <audio ref={audioRef} src={audioUrl} className="hidden" />}
      {/* Hidden/Floating Video Player for Sequence Playback */}
      {isFullscreen && currentPlayableScene && (
        <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-4">
          <button
            onClick={() => {
              setIsFullscreen(false);
              setIsPlaying(false);
              videoRef.current?.pause();
            }}
            className="absolute top-6 right-6 text-white/50 hover:text-white p-2"
          >
            Close Preview
          </button>
          <div className="max-w-4xl w-full aspect-video bg-black rounded-2xl overflow-hidden relative border border-white/10 shadow-2xl">
            <video
              ref={videoRef}
              src={videoUrl}
              onEnded={handleVideoElementEnded}
              onTimeUpdate={handleTimeUpdate}
              className="w-full h-full object-contain"
              controls={true}
              autoPlay
            />
            <div className="absolute bottom-6 left-6 right-6 bg-black/60 backdrop-blur-md border border-white/10 p-4 rounded-xl text-white">
              <div className="flex justify-between items-center mb-1">
                <h3 className="text-sm font-bold text-indigo-400">
                  Scene {currentSceneIdx + 1} / {totalPlayable}
                </h3>
                {currentPlayableScene?.selectedVideos &&
                  currentPlayableScene.selectedVideos.length > 0 && (
                    <span className="text-[10px] text-slate-400 font-mono">
                      Segment {currentSegmentsIdx + 1} /{" "}
                      {currentPlayableScene?.selectedVideos?.length || 0}
                    </span>
                  )}
              </div>
              <p className="text-sm italic opacity-90 leading-relaxed">
                {currentPlayableScene.text}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Timeline UI */}
      <div className="h-32 md:h-44 border-t border-white/10 bg-black/60 backdrop-blur-2xl p-3 md:p-4 flex-shrink-0">
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Timeline Editor
            {totalTimelineSec > 0
              ? `: ${formatTimelineDurationVi(totalTimelineSec)}`
              : ""}
            {!isReady ? " (Loading...)" : ""}
          </h3>
          <div className="flex items-center gap-2 md:gap-4">
            <span className="hidden sm:inline text-[9px] md:text-[10px] uppercase font-bold text-slate-400">
              Drag to reorder • +/- to trim
            </span>
            <span className="text-[10px] md:text-xs font-mono text-indigo-400">
              {validScenes.length} / {scenes.length} Videos
            </span>

            <button
              onClick={() => {
                setCurrentSceneIdx(0);
                setIsFullscreen(true);
                setIsPlaying(true);
              }}
              disabled={validScenes.length === 0}
              className="px-2 py-1 md:px-4 md:py-2 text-[9px] md:text-[10px] font-bold rounded-lg border-indigo-500/50 bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/40 disabled:opacity-50 disabled:hover:bg-indigo-500/20 transition-all border flex items-center gap-1 md:gap-2 relative overflow-hidden shadow-lg uppercase tracking-wider"
            >
              <MonitorPlay size={12} className="md:w-[14px] md:h-[14px]" />
              <span className="hidden xs:inline">Play Master</span>
              <span className="xs:hidden">Play</span>
            </button>
          </div>
        </div>

        <div className="flex gap-1 h-14 md:h-20 bg-white/5 rounded-lg p-1 overflow-x-auto custom-scrollbar">
          {scenes.flatMap((scene, sIdx) => {
            const hasVideos = scene.videos && scene.videos.length > 0;
            const segments =
              scene.selectedVideos && scene.selectedVideos.length > 0
                ? scene.selectedVideos
                : hasVideos
                  ? [
                      {
                        videoIdx: scene.selectedVideoIdx,
                        duration: scene.srtContext?.duration || 10,
                        startTimeOffset: 0,
                      },
                    ]
                  : [];

            if (segments.length === 0) {
              return (
                <div
                  key={`scene-${sIdx}`}
                  className={`h-full min-w-[80px] flex-1 rounded flex flex-col justify-end p-1 relative border transition-all ${
                    scene.loadingVideos
                      ? "bg-white/10 border-white/10 animate-pulse"
                      : "bg-white/5 border-white/10 opacity-30"
                  }`}
                >
                  <span className="text-[8px] font-mono relative z-10 truncate text-white/50 text-center mb-auto pt-2 uppercase opacity-40">
                    Loading Scene {sIdx + 1}
                  </span>
                </div>
              );
            }

            return segments.map((seg, segIdx) => {
              const video =
                scene.videos && (scene.videos[seg.videoIdx] || scene.videos[0]);
              const isTargetScene =
                currentSceneIdx ===
                validScenes.findIndex((s) => s.id === scene.id);
              const isTargetSegment =
                isTargetScene && currentSegmentsIdx === segIdx;
              const isTarget = isTargetSegment && isFullscreen;

              return (
                <div
                  key={`scene-${sIdx}-seg-${segIdx}`}
                  draggable
                  onDragStart={() => handleDragStart(sIdx, segIdx)}
                  onDragOver={handleDragOver}
                  onDrop={() => handleDrop(sIdx, segIdx)}
                  className={`h-full min-w-[140px] flex-shrink-0 rounded flex flex-col p-1 relative border transition-all group/seg select-none ${
                    isTarget
                      ? "bg-indigo-500/40 border-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.5)]"
                      : "bg-indigo-500/20 border-indigo-400/50 hover:bg-indigo-500/30 cursor-pointer"
                  }`}
                >
                  {video && (
                    <video
                      src={video.url}
                      className="absolute inset-0 w-full h-full object-cover opacity-10 rounded-[3px] group-hover/seg:opacity-20 transition-opacity"
                      preload="metadata"
                    />
                  )}

                  {/* Control Overlay */}
                  <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-hover/seg:opacity-100 transition-opacity z-20">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        updateDuration(sIdx, segIdx, -0.5);
                      }}
                      className="w-5 h-5 flex items-center justify-center bg-black/60 rounded text-white text-[10px] hover:bg-red-500/50"
                    >
                      -
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        updateDuration(sIdx, segIdx, 0.5);
                      }}
                      className="w-5 h-5 flex items-center justify-center bg-black/60 rounded text-white text-[10px] hover:bg-green-500/50"
                    >
                      +
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSegment(sIdx, segIdx);
                      }}
                      className="w-5 h-5 flex items-center justify-center bg-red-600/60 rounded text-white text-[10px] hover:bg-red-600"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>

                  <div
                    className="flex-1 flex flex-col justify-end"
                    onClick={(e) => {
                      const mappedIdx = validScenes.findIndex(
                        (s) => s.id === scene.id,
                      );
                      if (mappedIdx !== -1) {
                        setCurrentSceneIdx(mappedIdx);
                        setCurrentSegmentsIdx(segIdx);
                        setIsFullscreen(true);
                        setIsPlaying(true);
                      }
                    }}
                  >
                    <div className="relative z-10 flex flex-col leading-none">
                      <span className="text-[7px] font-bold text-indigo-300 uppercase tracking-tighter mb-0.5">
                        S{sIdx + 1} Clip {segIdx + 1}
                      </span>
                      <span
                        className="text-[10px] font-mono text-white font-bold bg-black/40 px-1 rounded self-start truncate max-w-full"
                        title={video?.title || "No video"}
                      >
                        {seg.duration.toFixed(1)}s{" "}
                        <span className="opacity-40 font-normal">
                          | {video?.title || "Unknown"}
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              );
            });
          })}
        </div>
      </div>
    </>
  );
}

// Helper to check if a response is the AI Studio cookie check page
async function handleApiResponse(res: Response, errorMessage: string) {
  const contentType = res.headers.get("content-type");
  
  if (!res.ok) {
    const errorData = (contentType && contentType.indexOf("application/json") !== -1) 
      ? await res.json() 
      : null;
    throw new Error(errorData?.error || `${errorMessage} (${res.status})`);
  }

  if (!contentType || contentType.indexOf("application/json") === -1) {
    const text = await res.text();
    if (text.includes("Cookie check") || text.includes("<!doctype html>")) {
      throw new Error("Trình duyệt chặn cookie. Vui lòng bấm 'Open in New Tab' ở góc trên bên phải để tiếp tục (icon cạnh Share)!");
    }
    throw new Error(`Server returned non-JSON response for ${errorMessage}`);
  }

  return res.json();
}

/**
 * Robustly parses JSON from AI responses, attempting to fix common syntax errors.
 */
function robustJsonParse(text: string): any {
  if (!text || typeof text !== "string") return {};

  let cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (initialError) {
    console.warn("Initial JSON parse failed, attempting recovery...", initialError);
    
    try {
      // 1. Handle missing quotes on property names (common in lazy JSON)
      cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');

      // 2. Handle missing closing braces for objects in arrays (the user's specific error)
      // Pattern: ] followed by , { instead of } , {
      cleaned = cleaned.replace(/(\s*\]\s*),\s*\{/g, '$1}, {');
      
      // 3. Handle trailing commas in arrays/objects
      cleaned = cleaned.replace(/,\s*([\]}])/g, "$1");

      // 4. If there are still missing braces at the end of the array items
      // Check for patterns like "... ] \n {" and fix them to "... ] } \n {"
      let lines = cleaned.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
         if (lines[i].trim().endsWith(']') && lines[i+1].trim().startsWith('{')) {
            lines[i] = lines[i].trim() + '}';
         }
      }
      cleaned = lines.join('\n');

      return JSON.parse(cleaned);
    } catch (recoveryError) {
       console.error("JSON Recovery failed:", recoveryError, "Final attempted text:", cleaned);
       throw recoveryError;
    }
  }
}

export default function App() {
  const [appUsername, setAppUsername] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [projects, setProjects] = useState<Project[]>([]);
  const [isCookieBlocked, setIsCookieBlocked] = useState(false);

  // Proactive check for AI Studio session/cookies
  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok && res.status === 401) {
          setIsCookieBlocked(true);
        } else {
          const contentType = res.headers.get("content-type");
          if (contentType && contentType.indexOf("text/html") !== -1) {
            const text = await res.text();
            if (text.includes("Cookie check") || text.includes("<!doctype html>")) {
              setIsCookieBlocked(true);
            }
          }
        }
      } catch (e) {
        console.error("Health check failed", e);
      }
    };
    checkSession();
  }, []);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectTitle, setEditingProjectTitle] = useState("");

  const [script, setScript] = useState("");
  const [tokenUsageByStage, setTokenUsageByStage] = useState<
    Record<
      string,
      {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
        thoughtsTokenCount: number;
        cachedContentTokenCount: number;
        toolUsePromptTokenCount: number;
      }
    >
  >({});

  const tokenUsage = React.useMemo(() => {
    const keys = Object.keys(tokenUsageByStage);
    if (keys.length === 0) return null;
    const total = {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
      thoughtsTokenCount: 0,
      cachedContentTokenCount: 0,
      toolUsePromptTokenCount: 0,
    };
    keys.forEach((k) => {
      const u = tokenUsageByStage[k];
      total.promptTokenCount += u.promptTokenCount;
      total.candidatesTokenCount += u.candidatesTokenCount;
      total.totalTokenCount += u.totalTokenCount;
      total.thoughtsTokenCount += u.thoughtsTokenCount;
      total.cachedContentTokenCount += u.cachedContentTokenCount;
      total.toolUsePromptTokenCount += u.toolUsePromptTokenCount;
    });
    return total;
  }, [tokenUsageByStage]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [proxyLogs, setProxyLogs] = useState<ProxyLog[]>([]);
  const defaultAppConfig = (): UserAppConfig => ({
    transcriptionModel: DEFAULT_GEMINI_MODEL,
    analysisModel: DEFAULT_GEMINI_MODEL,
    exportResolution: "1080p",
    geminiApiKey: "",
    storyblocksProxies: "",
    storyblocksCookies: "",
    driveAccessToken: "",
  });

  const parseStoredConfig = (parsed: Record<string, unknown>): UserAppConfig => ({
    transcriptionModel: migrateGeminiModelId(
      (parsed.transcriptionModel as string) || DEFAULT_GEMINI_MODEL,
    ),
    analysisModel: migrateGeminiModelId(
      (parsed.analysisModel as string) || DEFAULT_GEMINI_MODEL,
    ),
    exportResolution: (parsed.exportResolution as string) || "1080p",
    geminiApiKey: (parsed.geminiApiKey as string) || "",
    storyblocksProxies: (parsed.storyblocksProxies as string) || "",
    storyblocksCookies: (parsed.storyblocksCookies as string) || "",
    driveAccessToken: (parsed.driveAccessToken as string) || "",
  });

  const [config, setConfig] = useState<UserAppConfig>(defaultAppConfig);
  const [configReady, setConfigReady] = useState(false);

  const [viewMode, setViewMode] = useState<"editor" | "downloader">("editor");
  const [downloadJobs, setDownloadJobs] = useState<any[]>([]);
  const [mergeJobId, setMergeJobId] = useState<string | null>(null);

  useEffect(() => {
    setMergeJobId(null);
  }, [selectedProjectId]);

  useEffect(() => {
    let cancelled = false;
    const loadConfig = async () => {
      try {
        const legacyRaw = localStorage.getItem(LEGACY_CONFIG_STORAGE_KEY);
        let legacyConfig: UserAppConfig | null = null;
        if (legacyRaw) {
          try {
            legacyConfig = parseStoredConfig(JSON.parse(legacyRaw));
          } catch {
            /* ignore */
          }
        }
        const remote = await fetchUserConfig();
        if (cancelled) return;
        if (remote) {
          setConfig(parseStoredConfig(remote as unknown as Record<string, unknown>));
        } else if (legacyConfig) {
          setConfig(legacyConfig);
          await saveUserConfigApi(legacyConfig);
        }
        if (legacyRaw) localStorage.removeItem(LEGACY_CONFIG_STORAGE_KEY);
      } catch (e) {
        console.error("[config] load failed", e);
        const legacyRaw = localStorage.getItem(LEGACY_CONFIG_STORAGE_KEY);
        if (legacyRaw) {
          try {
            setConfig(parseStoredConfig(JSON.parse(legacyRaw)));
          } catch {
            /* ignore */
          }
        }
      } finally {
        if (!cancelled) setConfigReady(true);
      }
    };
    loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!configReady) return;
    const timer = setTimeout(() => {
      saveUserConfigApi(config).catch((e) =>
        console.warn("[config] save failed", e),
      );
    }, 800);
    return () => clearTimeout(timer);
  }, [config, configReady]);

  const [visualKeywordDirection, setVisualKeywordDirection] = useState("");

  const [pacingProfile, setPacingProfile] = useState<PacingProfile>({
    ...DEFAULT_PACING_PROFILE,
  });

  const [isProjectStudioSetupOpen, setIsProjectStudioSetupOpen] =
    useState(false);
  const [studioDraftVisual, setStudioDraftVisual] = useState("");
  const [studioDraftPacing, setStudioDraftPacing] = useState<PacingProfile>({
    ...DEFAULT_PACING_PROFILE,
  });

  // On mount: ask the backend whether a Drive refresh_token is already
  // stored on disk. If yes, fetch a fresh access_token and mark the UI
  // as connected. This way the user does not need to re-connect after
  // restarting the server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetch("/api/auth/google/status");
        if (!s.ok) return;
        const status = await s.json();
        if (!status.connected || cancelled) return;
        const t = await fetch("/api/auth/google/token");
        if (!t.ok || cancelled) return;
        const data = await t.json();
        if (data.accessToken) {
          setConfig((prev: any) => ({ ...prev, driveAccessToken: data.accessToken }));
        }
      } catch {
        /* silent — Drive simply not connected */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Use useMemo for AI client to react to custom API key changes
  const ai = React.useMemo(() => {
    try {
      // Prioritize user entered key, then system env
      const key =
        config.geminiApiKey && config.geminiApiKey.trim() !== ""
          ? config.geminiApiKey.trim()
          : typeof process !== "undefined"
            ? process.env.GEMINI_API_KEY
            : undefined;

      if (!key || typeof key !== "string" || key.trim() === "") {
        return null;
      }

      return new GoogleGenAI({ apiKey: key.trim() });
    } catch (e) {
      console.error("GoogleGenAI instantiation error:", e);
      return null;
    }
  }, [config.geminiApiKey]);

  const formatAIError = (err: any) => {
    const msg = err?.message || String(err);
    if (
      msg.includes("RESOURCE_EXHAUSTED") ||
      msg.includes("prepayment credits are depleted") ||
      msg.includes("429")
    ) {
      return "Hạn mức API (Quota) của hệ thống đã hết hoặc tài khoản hết số dư. Vui lòng vào 'Settings' (biểu tượng bánh răng góc trên) để nhập Gemini API Key cá nhân của bạn để tiếp tục.";
    }
    return msg;
  };

  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [uploadedAudioFile, setUploadedAudioFile] = useState<File | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [sceneMergeSelection, setSceneMergeSelection] = useState<number[]>(
    [],
  );
  const [regeneratingKeywordsIdx, setRegeneratingKeywordsIdx] = useState<
    number | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"script" | "preview">("script");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // Sync audio URL with uploaded file
  useEffect(() => {
    if (uploadedAudioFile) {
      const url = URL.createObjectURL(uploadedAudioFile);
      setAudioUrl(url);
      return () => {
        URL.revokeObjectURL(url);
        setAudioUrl(null);
      };
    }
  }, [uploadedAudioFile]);

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const audioInputRef = React.useRef<HTMLInputElement>(null);

  const handleImportSRT = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setScript(text);
      setIsDirty(true);
    };
    reader.readAsText(file);
    if (e.target) e.target.value = "";
  };

  const transcribeAudio = async (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = async () => {
        try {
          if (!ai) {
            throw new Error(
              "Gemini API Key chưa được thiết lập. Vui lòng kiểm tra Settings hoặc cung cấp Key.",
            );
          }
          const base64Data = (reader.result as string).split(",")[1];
          const result = await ai.models.generateContent({
            model: config.transcriptionModel,
            contents: [
              {
                role: "user",
                parts: [
                  {
                    inlineData: {
                      mimeType: file.type || "audio/mp3",
                      data: base64Data,
                    },
                  },
                  {
                    text: "Lắng nghe file âm thanh này và tạo transcript dưới định dạng chuẩn SRT. Trả về đúng định dạng SRT dài chi tiết với phân giải timestamp chính xác. Chỉ trả về text chuẩn của định dạng SRT duy nhất, không giải thích gì thêm.",
                  },
                ],
              },
            ],
          });

          const text = result.text;

          if (result.usageMetadata) {
            setTokenUsageByStage((prev) => ({
              ...prev,
              transcribe: parseUsageMetadata(result.usageMetadata),
            }));
          }

          resolve(text || "");
        } catch (err: any) {
          reject(
            new Error("Lỗi khi dùng AI tạo transcript: " + formatAIError(err)),
          );
        }
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const handleImportMP3 = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsTranscribing(true);
    toast.loading("Đang phân tích âm thanh và tạo SRT...", {
      id: "transcribing",
    });

    try {
      const srtContent = await transcribeAudio(file);

      if (!srtContent || srtContent.length < 10) {
        throw new Error("Không thể trích xuất phụ đề từ âm thanh này.");
      }

      setUploadedAudioFile(file);
      setScript(srtContent);
      toast.success("Đã tạo phụ đề từ âm thanh!", { id: "transcribing" });

      // Auto trigger process
      setTimeout(() => {
        handleProcessScript();
      }, 500);
    } catch (err: any) {
      console.error("Transcription error:", err);
      toast.error(err.message || "Lỗi khi xử lý MP3", { id: "transcribing" });
    } finally {
      setIsTranscribing(false);
      if (e.target) e.target.value = "";
    }
  };

  useEffect(() => {
    let cancelled = false;
    const restoreSession = async () => {
      const stored = loadAppSession();
      if (!stored?.token) {
        if (!cancelled) {
          setAppUsername(null);
          setAuthLoading(false);
        }
        return;
      }
      const ok = await verifyAppSession(stored.token);
      if (!cancelled) {
        if (ok) {
          setAppUsername(stored.username);
        } else {
          clearAppSession();
          setAppUsername(null);
        }
        setAuthLoading(false);
      }
    };
    restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAppLogin = async (username: string, password: string) => {
    const session = await loginApp(username, password);
    setAppUsername(session.username);
  };

  const handleAppLogout = () => {
    clearAppSession();
    setAppUsername(null);
    setSelectedProjectId(null);
    toast.success("Đã đăng xuất");
  };

  const openProjectStudioSetup = () => {
    if (!selectedProjectId) return;
    setStudioDraftVisual(visualKeywordDirection);
    setStudioDraftPacing({ ...pacingProfile });
    setIsProjectStudioSetupOpen(true);
  };

  const persistProjectStudioFields = async (
    visual: string,
    pacing: PacingProfile,
  ) => {
    if (!selectedProjectId) return;
    try {
      const updated = await updateProjectApi(selectedProjectId, {
        visualKeywordDirection: visual,
        pacingProfileJson: JSON.stringify(pacing),
      });
      setProjects((prev) =>
        prev.map((p) => (p.id === selectedProjectId ? updated : p)),
      );
    } catch (e) {
      console.error("persistProjectStudioFields", e);
      toast.error("Không lưu được thiết lập dự án lên server.");
    }
  };

  const applyProjectStudioSetup = () => {
    const normalizedPacing = normalizePacingProfile(studioDraftPacing);
    setVisualKeywordDirection(studioDraftVisual);
    setPacingProfile(normalizedPacing);
    setStudioDraftPacing(normalizedPacing);
    persistProjectStudioFields(studioDraftVisual, normalizedPacing);
    setIsProjectStudioSetupOpen(false);
    setIsDirty(true);
    toast.success("Đã lưu thiết lập cho dự án.");
  };

  const cancelProjectStudioSetup = () => {
    setIsProjectStudioSetupOpen(false);
  };

  useEffect(() => {
    let cancelled = false;
    const loadProjectsFromBackend = async () => {
      try {
        const legacyRaw = localStorage.getItem(LEGACY_PROJECTS_STORAGE_KEY);
        if (legacyRaw) {
          try {
            const legacy = JSON.parse(legacyRaw) as Project[];
            if (legacy.length > 0) {
              await migrateProjectsApi(legacy);
            }
          } catch (e) {
            console.warn("[projects] legacy migrate parse failed", e);
          }
          localStorage.removeItem(LEGACY_PROJECTS_STORAGE_KEY);
        }
        const list = await fetchProjects();
        if (!cancelled) setProjects(list);
      } catch (e) {
        console.error("[projects] load failed", e);
        if (!cancelled) {
          toast.error("Không tải được dự án từ server.");
          setProjects([]);
        }
      }
    };
    loadProjectsFromBackend();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load selected project
  useEffect(() => {
    const proj = projects.find((p) => p.id === selectedProjectId);
    if (proj) {
      setScript(proj.script || "");
      try {
        setScenes(proj.scenes ? JSON.parse(proj.scenes) : []);
      } catch (e) {
        console.error("Failed to parse scenes", e);
        setScenes([]);
      }
      setVisualKeywordDirection(proj.visualKeywordDirection || "");
      try {
        if (proj.pacingProfileJson) {
          const parsed = JSON.parse(proj.pacingProfileJson);
          setPacingProfile(
            normalizePacingProfile({ ...DEFAULT_PACING_PROFILE, ...parsed }),
          );
        } else {
          setPacingProfile({ ...DEFAULT_PACING_PROFILE });
        }
      } catch {
        setPacingProfile({ ...DEFAULT_PACING_PROFILE });
      }
      const persistedAudio = proj.audioUrl;
      if (persistedAudio && /^https?:\/\//i.test(persistedAudio)) {
        setAudioUrl(persistedAudio);
      } else {
        setAudioUrl(null);
      }
      setDownloadUrl(proj.downloadUrl || null);
      setSceneMergeSelection([]);
    } else {
      setScript("");
      setScenes([]);
      setSceneMergeSelection([]);
      setVisualKeywordDirection("");
      setPacingProfile({ ...DEFAULT_PACING_PROFILE });
      setAudioUrl(null);
      setDownloadUrl(null);
    }
  }, [selectedProjectId, projects]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectTitle.trim()) return;

    setIsCreatingProject(true);
    try {
      const newRefId =
        "proj_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
      const newProject = await createProjectApi(
        newProjectTitle.trim(),
        newRefId,
      );

      setProjects((prev) => [newProject, ...prev]);

      setNewProjectTitle("");
      setSelectedProjectId(newProject.id);
      toast.success("Đã tạo dự án");
    } catch (error: any) {
      console.error(error);
      const msg = error instanceof Error ? error.message : String(error);
      toast.error("Failed to create project: " + msg);
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleDeleteProject = async (
    projectId: string,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    console.log("Request to delete project:", projectId);
    const toastId = toast.loading("Đang xoá dự án...");
    try {
      await deleteProjectApi(projectId);

      setProjects((prev) => prev.filter((p) => p.id !== projectId));

      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
      }
      toast.success("Đã xoá dự án", { id: toastId });
    } catch (error: any) {
      console.error("Delete error details:", error);
      const errorMessage = error?.message || String(error);
      toast.error("Lỗi khi xoá dự án: " + errorMessage, { id: toastId });
    }
  };

  const startEditingProject = (proj: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProjectId(proj.id);
    setEditingProjectTitle(proj.title);
  };

  const handleUpdateProjectTitle = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!editingProjectId || !editingProjectTitle.trim()) {
      setEditingProjectId(null);
      return;
    }

    try {
      const updated = await updateProjectApi(editingProjectId, {
        title: editingProjectTitle.trim(),
      });
      setProjects((prev) =>
        prev.map((p) => (p.id === editingProjectId ? updated : p)),
      );

      setEditingProjectId(null);
      toast.success("Đã đổi tên dự án");
    } catch (error) {
       console.error("Failed to update project title", error);
    }
  };

  const [isDirty, setIsDirty] = useState(false);

  // Auto-save effect: Triggers when the project state is "dirty" (has unsaved changes)
  useEffect(() => {
    if (isDirty && selectedProjectId) {
      const timer = setTimeout(() => {
        saveProjectState(script, scenes);
      }, 2000); // 2-second debounce to prevent excessive Firestore writes
      return () => clearTimeout(timer);
    }
  }, [
    isDirty,
    script,
    scenes,
    visualKeywordDirection,
    pacingProfile,
    audioUrl,
    downloadUrl,
    selectedProjectId,
  ]);

  const saveProjectState = async (
    newScript: string,
    newScenes: Scene[],
    manual = false,
  ) => {
    if (!selectedProjectId) return;

    if (manual) setIsSaving(true);
    try {
      const cleanedScenes = JSON.parse(JSON.stringify(newScenes));
      const persistAudio =
        audioUrl && /^https?:\/\//i.test(audioUrl) ? audioUrl : null;

      const updated = await updateProjectApi(selectedProjectId, {
        script: newScript,
        scenes: JSON.stringify(cleanedScenes),
        visualKeywordDirection,
        pacingProfileJson: JSON.stringify(pacingProfile),
        audioUrl: persistAudio,
        downloadUrl: downloadUrl || null,
      });

      setProjects((prev) =>
        prev.map((p) => (p.id === selectedProjectId ? updated : p)),
      );

      setIsDirty(false);
      if (manual) toast.success("Đã lưu dự án lên server");
    } catch (error: any) {
      console.error("Save error:", error);
      if (manual) toast.error("Lưu dự án thất bại");
    } finally {
      if (manual) setIsSaving(false);
    }
  };

  const handleScriptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setScript(val);
    setIsDirty(true);
  };

  const refetchSceneVideos = async (sceneIdx: number, newKeyword: string) => {
    const sceneText = scenes[sceneIdx]?.text || "";
    const sceneDuration = scenes[sceneIdx]?.srtContext?.duration;
    
    setScenes((prev) => {
      const copy = [...prev];
      copy[sceneIdx] = {
        ...copy[sceneIdx],
        keyword: newKeyword,
        loadingVideos: true,
        videos: [],
        selectedVideoIdx: 0,
      };
      return copy;
    });
    setIsDirty(true);

    await fetchSceneVideos(newKeyword, sceneIdx, sceneText, sceneDuration, {
      choicesLimit: pacingProfile.storyblocksChoicesPerKeyword,
    });
  };

  const toggleSceneMergeSelection = (idx: number) => {
    setSceneMergeSelection((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx],
    );
  };

  const handleMergeSelectedScenes = () => {
    if (sceneMergeSelection.length < 2) {
      toast.error("Chọn ít nhất 2 phân cảnh để gộp.");
      return;
    }
    const merged = mergeEditorScenesAtIndices(scenes, sceneMergeSelection);
    setScenes(merged);
    setSceneMergeSelection([]);
    setIsDirty(true);
    toast.success(
      `Đã gộp ${sceneMergeSelection.length} phân cảnh. Bấm «Render lại keywords EN» để đề xuất từ khóa mới.`,
    );
  };

  const handleRegenerateKeywordsEN = async (sceneIdx: number) => {
    const scene = scenes[sceneIdx];
    if (!scene?.text?.trim()) return;

    if (!ai) {
      toast.error(
        "Cần Gemini API Key (Settings) để đề xuất keywords EN.",
      );
      setIsSettingsOpen(true);
      return;
    }

    setRegeneratingKeywordsIdx(sceneIdx);
    const toastId = `regen-kw-${sceneIdx}`;
    toast.loading("Gemini — đề xuất keywords EN cho phân cảnh đã gộp...", {
      id: toastId,
    });

    try {
      const draft = visualDraftFromEditorScene(scene, 0);
      const langHint = detectSubtitleLangHint([{ text: scene.text }]);

      const kwPrompt = buildSceneKeywordsPrompt(
        [draft],
        visualKeywordDirection,
        langHint,
      );
      const viPrompt = buildVietnameseSceneNotesPrompt([draft]);

      const [kwRes, viRes] = await Promise.all([
        ai.models.generateContent({
          model: config.analysisModel,
          contents: [{ role: "user", parts: [{ text: kwPrompt }] }],
          config: buildGeminiJsonConfig("scene_keywords"),
        }),
        ai.models.generateContent({
          model: config.analysisModel,
          contents: [{ role: "user", parts: [{ text: viPrompt }] }],
          config: buildGeminiJsonConfig("scene_summaries_vi"),
        }),
      ]);

      if (kwRes.usageMetadata) {
        setTokenUsageByStage((prev) => ({
          ...prev,
          scene_keywords: parseUsageMetadata(kwRes.usageMetadata),
        }));
      }

      let plans;
      try {
        const kwParsed = robustJsonParse(kwRes.text || "{}");
        plans = parseKeywordPlans(kwParsed, 1, [draft]);
      } catch {
        plans = parseKeywordPlans({}, 1, [draft]);
      }
      if (plansLookGeneric(plans)) {
        plans = mergeKeywordPlansWithDrafts(plans, [draft]);
      }

      let summaryVi = scene.srtContext?.summaryVi || "";
      try {
        const viParsed = robustJsonParse(viRes.text || "{}");
        const notes = parseVietnameseSceneNotes(viParsed, 1, [draft]);
        summaryVi = notes[0] || summaryVi;
      } catch {
        /* giữ ghi chú cũ */
      }

      const plan = plans[0];
      const primary = primaryKeywordFromPlan(plan);

      setScenes((prev) => {
        const copy = [...prev];
        copy[sceneIdx] = {
          ...copy[sceneIdx],
          keyword: primary,
          videos: [],
          selectedVideoIdx: 0,
          selectedVideos: [],
          loadingVideos: true,
          srtContext: {
            ...copy[sceneIdx].srtContext,
            startTime:
              copy[sceneIdx].srtContext?.startTime || "00:00:00,000",
            endTime: copy[sceneIdx].srtContext?.endTime || "00:00:00,000",
            duration: copy[sceneIdx].srtContext?.duration ?? draft.durationSec,
            keywords: plan.keywords,
            fallbackKeywords: plan.fallback_keywords,
            storyblocksSearchQueries: plan.storyblocks_search_queries,
            summaryVi,
            pacingZone:
              copy[sceneIdx].srtContext?.pacingZone || draft.pacingZone,
          },
        };
        return copy;
      });
      setIsDirty(true);

      toast.dismiss(toastId);
      toast.success(`Keywords EN: «${primary}» — đang tìm Storyblocks...`);

      await fetchSceneVideos(
        primary,
        sceneIdx,
        scene.text,
        scene.srtContext?.duration ?? draft.durationSec,
        { choicesLimit: pacingProfile.storyblocksChoicesPerKeyword },
      );
    } catch (err: any) {
      console.error("Regenerate keywords:", err);
      toast.dismiss(toastId);
      toast.error(formatAIError(err));
      setScenes((prev) => {
        const copy = [...prev];
        if (copy[sceneIdx]) {
          copy[sceneIdx] = { ...copy[sceneIdx], loadingVideos: false };
        }
        return copy;
      });
    } finally {
      setRegeneratingKeywordsIdx(null);
    }
  };

  const handleProcessScript = async () => {
    if (!script.trim()) return;

    // Early check if AI is needed but missing
    const isSRT =
      /^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/m.test(
        script,
      );

    if (!ai && isSRT) {
      setError("Gemini API Key chưa được thiết lập. Vui lòng kiểm tra Settings để sử dụng tính năng SRT.");
      return;
    }

    setIsProcessing(true);
    setTokenUsageByStage({});
    setError(null);
    try {
      let initialScenes: Scene[] = [];

      if (isSRT) {
        toast.loading("Đang phân tích SRT bằng code...", { id: "analyze-srt" });
        const blocks = parseSRT(script);
        if (blocks.length === 0)
          throw new Error("File SRT không hợp lệ hoặc rỗng.");

        if (!ai) throw new Error("Gemini API Key chưa được thiết lập.");

        const linePayload = blocks.map((b, idx) => ({
          index: idx,
          text: b.text,
          start_sec: b.startTime,
          end_sec: b.endTime,
        }));
        const subBlocks = blocksToSubtitleBlocks(blocks);
        const langHint = detectSubtitleLangHint(linePayload);

        toast.loading("Gemini — Meaning beats (lớp nội dung)...", {
          id: "analyze-srt",
        });

        const beatsPrompt = buildMeaningBeatsPrompt(
          linePayload,
          visualKeywordDirection,
          langHint,
        );
        const beatsRes = await ai.models.generateContent({
          model: config.analysisModel,
          contents: [{ role: "user", parts: [{ text: beatsPrompt }] }],
          config: buildGeminiJsonConfig("meaning_beats"),
        });

        if (beatsRes.usageMetadata) {
          setTokenUsageByStage((prev) => ({
            ...prev,
            meaning_beats: parseUsageMetadata(beatsRes.usageMetadata),
          }));
        }

        let meaningBeats: any[] = [];
        try {
          const beatsParsed = robustJsonParse(beatsRes.text || "{}");
          meaningBeats = Array.isArray(beatsParsed.meaning_beats)
            ? beatsParsed.meaning_beats
            : [];
        } catch (e) {
          console.error("Meaning beats parse error:", e);
          toast.error(
            "Không đọc được meaning beats. Gom cảnh theo luật mặc định.",
            { id: "analyze-srt" },
          );
        }

        if (meaningBeats.length === 0) {
          meaningBeats = ruleBasedMeaningBeats(subBlocks, 4);
          toast(
            langHint === "de"
              ? "SRT tiếng Đức — gom phân cảnh theo luật (Gemini beats trống)."
              : "Gom phân cảnh theo luật (Gemini beats trống).",
            { id: "analyze-srt", icon: "ℹ️" },
          );
        }

        toast.loading("Rule engine — gom phân cảnh & pacing...", {
          id: "analyze-srt",
        });

        const drafts = mergeMeaningBeatsToVisualScenes(
          meaningBeats,
          subBlocks,
          pacingProfile,
        );

        if (drafts.length === 0)
          throw new Error("Không thể tạo visual scene từ SRT.");

        toast.loading(
          "Gemini — Keywords EN + ghi chú tiếng Việt (song song)...",
          { id: "analyze-srt" },
        );

        const kwPrompt = buildSceneKeywordsPrompt(
          drafts,
          visualKeywordDirection,
          langHint,
        );
        const viPrompt = buildVietnameseSceneNotesPrompt(drafts);

        const [kwRes, viRes] = await Promise.all([
          ai.models.generateContent({
            model: config.analysisModel,
            contents: [{ role: "user", parts: [{ text: kwPrompt }] }],
            config: buildGeminiJsonConfig("scene_keywords"),
          }),
          ai.models.generateContent({
            model: config.analysisModel,
            contents: [{ role: "user", parts: [{ text: viPrompt }] }],
            config: buildGeminiJsonConfig("scene_summaries_vi"),
          }),
        ]);

        if (kwRes.usageMetadata) {
          setTokenUsageByStage((prev) => ({
            ...prev,
            scene_keywords: parseUsageMetadata(kwRes.usageMetadata),
          }));
        }
        if (viRes.usageMetadata) {
          setTokenUsageByStage((prev) => ({
            ...prev,
            scene_summaries_vi: parseUsageMetadata(viRes.usageMetadata),
          }));
        }

        let vietnameseNotes: string[] = [];
        try {
          const viParsed = robustJsonParse(viRes.text || "{}");
          vietnameseNotes = parseVietnameseSceneNotes(
            viParsed,
            drafts.length,
            drafts,
          );
        } catch (e) {
          console.error("Vietnamese scene notes parse error:", e);
          vietnameseNotes = parseVietnameseSceneNotes({}, drafts.length, drafts);
        }

        let plans;
        try {
          const kwParsed = robustJsonParse(kwRes.text || "{}");
          plans = parseKeywordPlans(kwParsed, drafts.length, drafts);
        } catch (e) {
          console.error("Keyword plan parse error:", e);
          plans = parseKeywordPlans({}, drafts.length, drafts);
        }

        if (plansLookGeneric(plans)) {
          console.warn(
            "[SRT] Keyword plans generic — merging with draft topics/hints",
          );
          plans = mergeKeywordPlansWithDrafts(plans, drafts);
          toast(
            langHint === "de"
              ? "Đã bổ sung từ khóa EN từ nội dung từng phân cảnh (tránh 'B-roll Footage' chung)."
              : "Đã bổ sung từ khóa EN theo từng phân cảnh.",
            { duration: 4000 },
          );
        }

        initialScenes = drafts.map((d, i) => {
          const plan = plans[i];
          const primary =
            plan.storyblocks_search_queries[0] ||
            plan.keywords[0] ||
            "stock video b-roll";
          return {
            id: i + 1,
            text: d.text,
            keyword: primary,
            videos: [],
            selectedVideoIdx: 0,
            selectedVideos: [],
            loadingVideos: true,
            srtContext: {
              startTime: formatSRTTime(d.startTime),
              endTime: formatSRTTime(d.endTime),
              duration: d.durationSec,
              keywords: plan.keywords,
              fallbackKeywords: plan.fallback_keywords,
              storyblocksSearchQueries: plan.storyblocks_search_queries,
              summaryVi: vietnameseNotes[i] || d.summaryVi || d.text.slice(0, 160),
              pacingZone: d.pacingZone,
            },
          };
        });

        const integrity = validateSrtSceneTextIntegrity(subBlocks, drafts);
        if (!integrity.ok) {
          console.error(
            "[SRT] Text integrity failed",
            integrity.missingLineCount > 0
              ? `missing ${integrity.missingLineCount} subtitle lines`
              : "normalized text mismatch",
            { sceneCount: drafts.length },
          );
          throw new Error(
            integrity.missingLineCount > 0
              ? `Lỗi hệ thống: ${integrity.missingLineCount} dòng SRT không nằm trong phân cảnh. Hãy thử lại hoặc chia nhỏ file.`
              : "Lỗi hệ thống: Nội dung phân cảnh không khớp SRT gốc (khoảng trắng/unicode). Hãy thử phân tích lại.",
          );
        }

        toast.dismiss("analyze-srt");
        toast.success(
          `Đã tạo ${initialScenes.length} phân cảnh (Scene Planning + Storyblocks EN).`,
        );
      } else {
        let aiScenes: any[] = [];

        if (!ai) {
          console.warn(
            "Gemini API Key chưa được thiết lập. Sử dụng danh sách trực tiếp.",
          );
          const lines = script
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          aiScenes = lines.map((line, idx) => ({
            id: idx + 1,
            text: line,
            keyword: line,
          }));
        } else {
          toast.loading("Google Gemini đang tối ưu Keywords...", { id: "analyze-srt" });
          const prompt = `Tối ưu Keywords (English News/Military/Politics) cho từng dòng văn bản.
Chủ đề: News, Politics, Military, Charts.
Nguyên tắc: subjet + action, ngắn gọn 2-4 từ.
Chỉ trả về JSON: {"scenes": [{"id": 1, "text": "...", "keyword": "..."}]}
Văn bản: ${script}`;

          try {
            const result = await ai.models.generateContent({
              model: config.analysisModel,
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              config: buildGeminiJsonConfig("keyword_generation"),
            });

            const resultText = result.text;

            if (result.usageMetadata) {
              setTokenUsageByStage((prev) => ({
                ...prev,
                keyword_generation: parseUsageMetadata(result.usageMetadata),
              }));
            }

            const cleanResultText = (resultText || "{}")
              .replace(/^```(?:json)?\s*/i, "")
              .replace(/\s*```$/i, "")
              .trim();
            let parsedData: any = {};
            try {
              parsedData = JSON.parse(cleanResultText);
            } catch (e) {
              console.error("JSON Parse Error:", e, "Raw Text:", resultText);
            }

            if (Array.isArray(parsedData)) {
              aiScenes = parsedData;
            } else if (parsedData.scenes && Array.isArray(parsedData.scenes)) {
              aiScenes = parsedData.scenes;
            } else if (parsedData.data && Array.isArray(parsedData.data)) {
              aiScenes = parsedData.data;
            }

            if (aiScenes.length === 0) {
              console.warn(
                "Failed to parse keywords from:",
                resultText,
                "Falling back to directly mapped lines.",
              );
              const lines = script
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
              aiScenes = lines.map((line, idx) => ({
                id: idx + 1,
                text: line,
                keyword: line,
              }));
            }
          } catch (error: any) {
            console.error("Gemini API Error:", error);
            toast.error(
              "Lỗi AI khi phân tích, sử dụng câu text gốc làm keyword.",
            );
            const lines = script
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            aiScenes = lines.map((line, idx) => ({
              id: idx + 1,
              text: line,
              keyword: line,
            }));
          }
        }

        initialScenes = aiScenes.map((scene: any, index: number) => {
          const textStr = scene.text || `Line ${index + 1}`;
          const wordCount = textStr.trim().split(/\s+/).length;
          // Estimate reading speed: ~150 words per minute -> 2.5 words per sec.
          const estimatedDuration = Math.max(3, Math.ceil(wordCount / 2.5));
          return {
            id: scene.id || index + 1,
            text: textStr,
            keyword: scene.keyword || "",
            videos: [],
            selectedVideoIdx: 0,
            selectedVideos: [],
            loadingVideos: true,
            srtContext: {
              startTime: "00:00:00,000",
              endTime: formatSRTTime(estimatedDuration),
              duration: estimatedDuration,
              keywords: scene.keyword ? [scene.keyword] : [],
            },
          };
        });
      }

      setScenes(initialScenes);
      setIsDirty(true);
      toast.dismiss("analyze-srt");
      
      // Process sequentially to avoid WAF block from too many concurrent puppeteer instances
      for (let i = 0; i < initialScenes.length; i++) {
        const scene = initialScenes[i];
        if (scene.keyword) {
          await fetchSceneVideos(
            scene.keyword,
            i,
            scene.text,
            scene.srtContext?.duration,
            {
              choicesLimit: pacingProfile.storyblocksChoicesPerKeyword,
            },
          );
        } else {
          setScenes((prev) => {
            const updated = [...prev];
            updated[i] = { ...updated[i], loadingVideos: false };
            return updated;
          });
        }
      }
    } catch (err: any) {
      setError(formatAIError(err));
      console.error("Error:", err);
      toast.dismiss("analyze-srt");
    } finally {
      setIsProcessing(false);
    }
  };

  const fetchSceneVideos = async (
    keyword: string,
    index: number,
    sceneText: string,
    sceneDuration?: number,
    fetchOpts?: { choicesLimit?: number },
  ) => {
    try {
      const normalizedKeyword = keyword.trim().toLowerCase();
      let allVideos: VideoResult[] = [];

      if (searchCache.has(normalizedKeyword)) {
        allVideos = searchCache.get(normalizedKeyword);
      } else {
        let proxyList: string[] = [];
        if (config.storyblocksProxies) {
          proxyList = config.storyblocksProxies
            .split("\n")
            .map((p) => p.trim())
            .filter(Boolean);
        }

        const res = await fetch(`/api/scrape`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keyword: normalizedKeyword,
            proxies: proxyList,
          }),
        });

        const data = await handleApiResponse(res, "scrape");
        allVideos = data.videos || [];
        searchCache.set(normalizedKeyword, allVideos);

        if (data.proxy) {
          setProxyLogs((prev) => {
            const newLogs = [...prev];
            newLogs.unshift({
              id: Date.now().toString() + Math.random().toString(),
              proxy: data.proxy,
              keyword: normalizedKeyword,
              status: "success",
              timestamp: new Date(),
              videosFound: allVideos.length,
            });
            return newLogs.slice(0, 50);
          });
        }
      }

      const reqDuration = sceneDuration || 10;
      const limit =
        fetchOpts?.choicesLimit ??
        pacingProfile.storyblocksChoicesPerKeyword;

      const ranked = rankStockVideos(allVideos, reqDuration);
      const displayVideos = ranked.filtered.slice(0, limit);

      let bestIdx = 0;
      let selectedSegments: SelectedVideo[] = [];

      if (displayVideos.length > 0) {
        selectedSegments = normalizeSceneSelectedVideos(
          [{ videoIdx: 0, startTimeOffset: 0, duration: reqDuration }],
          0,
          reqDuration,
        );
        bestIdx = 0;
      }

      setScenes((prev) => {
        const updated = [...prev];
        if (updated[index] && updated[index].keyword === keyword) {
          updated[index] = {
            ...updated[index],
            videos: displayVideos,
            loadingVideos: false,
            selectedVideoIdx: bestIdx,
            selectedVideos: selectedSegments,
          };
        }
        return updated;
      });
      setIsDirty(true);
    } catch (error: any) {
      console.error("Error fetching videos:", error);
      const msg =
        error.message === "Failed to fetch"
          ? "Kết nối server thất bại (Failed to fetch). Hãy thử refresh trang."
          : error.message;
      toast.error(`Lỗi: ${msg}`);
      setScenes((prev) => {
        const updated = [...prev];
        if (updated[index] && updated[index].keyword === keyword) {
          updated[index] = { ...updated[index], loadingVideos: false };
        }
        return updated;
      });
    }
  };

  const handleSelectVideo = (sceneIdx: number, videoIdx: number) => {
    setScenes((prev) => {
      const updated = [...prev];
      const scene = updated[sceneIdx];
      const target = scene.srtContext?.duration || 10;
      updated[sceneIdx] = {
        ...scene,
        selectedVideoIdx: videoIdx,
        selectedVideos: normalizeSceneSelectedVideos(
          [
            {
              videoIdx,
              startTimeOffset: 0,
              duration: target,
            },
          ],
          videoIdx,
          target,
        ),
      };
      return updated;
    });
    setIsDirty(true);
  };

  const handleConnectDrive = async () => {
    // ----------------------------------------------------------------
    //  Server-side OAuth 2.0 flow (no Firebase dependency)
    //  Opens a popup -> /api/auth/google/login (which redirects to Google)
    //  After Google consent, /api/auth/google/callback persists refresh_token
    //  server-side and posts back a `drive-oauth-success` message.
    //  We then fetch the current access_token for display.
    // ----------------------------------------------------------------
    const loadingId = toast.loading("Đang kết nối Google Drive...");
    try {
      const popup = window.open(
        "/api/auth/google/login",
        "drive-oauth",
        "width=520,height=680"
      );
      if (!popup) {
        toast.dismiss(loadingId);
        toast.error("Popup bị chặn. Hãy cho phép popup cho localhost rồi thử lại.");
        return;
      }

      // Wait for the callback page to post a success message, OR
      // for the popup to be closed (user cancelled).
      const result = await new Promise<"success" | "cancelled">((resolve) => {
        const onMessage = (event: MessageEvent) => {
          if (event.data?.type === "drive-oauth-success") {
            cleanup();
            resolve("success");
          }
        };
        const pollClosed = setInterval(() => {
          if (popup.closed) {
            cleanup();
            resolve("cancelled");
          }
        }, 500);
        const cleanup = () => {
          window.removeEventListener("message", onMessage);
          clearInterval(pollClosed);
        };
        window.addEventListener("message", onMessage);
        // 5-minute safety timeout
        setTimeout(() => {
          cleanup();
          if (!popup.closed) popup.close();
          resolve("cancelled");
        }, 5 * 60 * 1000);
      });

      if (result !== "success") {
        toast.dismiss(loadingId);
        toast.error("Kết nối Drive bị hủy.");
        return;
      }

      // Fetch a fresh access token to store in frontend state (for UI display).
      // The backend will keep using its stored refresh_token regardless.
      const r = await fetch("/api/auth/google/token");
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      toast.dismiss(loadingId);
      toast.success("Kết nối Google Drive thành công!");
      setConfig({ ...config, driveAccessToken: data.accessToken });
    } catch (e: any) {
      toast.dismiss(loadingId);
      toast.error("Kết nối Drive thất bại: " + (e?.message || String(e)));
    }
  };

  const handleOpenDownloader = () => {
     if (!selectedProjectId) {
        toast.error("Vui lòng chọn một dự án trước.");
        return;
     }
     setViewMode("downloader");
  };

  const handleAutomationMerge = async (projectId: string, scenes: any[], mergeResolution: string = "1080p") => {
      try {
          const formData = new FormData();
          formData.append("scenes", JSON.stringify(scenes));
          formData.append("mergeResolution", mergeResolution || "1080p");
          if (config.driveAccessToken) {
            formData.append("driveToken", config.driveAccessToken);
          }
          if (uploadedAudioFile) {
            formData.append("audio", uploadedAudioFile);
          }
          const response = await fetch(`/api/projects/${projectId}/merge`, {
            method: "POST",
            body: formData,
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            toast.error(
              typeof data.error === "string"
                ? data.error
                : `Merge không khởi chạy được (${response.status})`,
            );
            return;
          }
          if (data.mergeJobId) {
             toast.success("Merge job initiated!" + (uploadedAudioFile ? " (kèm nhạc nền)" : ""));
             setMergeJobId(data.mergeJobId);
             try {
               const updated = await updateProjectApi(projectId, {
                 status: "editing",
               });
               setProjects((prev) =>
                 prev.map((p) => (p.id === projectId ? updated : p)),
               );
             } catch {
               /* không chặn merge */
             }
          } else {
             toast.error(data.error || "Failed to start merge job");
          }
      } catch (error) {
          toast.error("Failed to start merge job");
      }
  };

  if (authLoading)
    return (
      <div className="h-screen w-full bg-slate-950 flex flex-col items-center justify-center gap-4">
        <Loader2 className="w-10 h-10 text-indigo-500 animate-spin" />
        <p className="text-slate-400 font-mono text-xs uppercase tracking-widest animate-pulse">
          {getAppVersionTitle()} — đang khởi động...
        </p>
      </div>
    );

  if (!appUsername) {
    return (
      <AppLoginScreen
        onLogin={handleAppLogin}
        onSuccess={() => {
          const s = loadAppSession();
          setAppUsername(s?.username || null);
        }}
      />
    );
  }

  const formatError = (err: string) => {
    if (!err) return "";
    try {
      const parsed = JSON.parse(err);
      if (
        parsed.error &&
        (parsed.error.includes("Quota limit exceeded") ||
          parsed.error.includes("resource-exhausted"))
      ) {
        return "Firestore Quota exceeded (Daily Free Limit). Saves and data operations are temporarily disabled until reset.";
      }
      return parsed.error || err;
    } catch (e) {
      if (
        err.includes("Quota limit exceeded") ||
        err.includes("resource-exhausted")
      ) {
        return "Firestore Quota exceeded (Daily Free Limit). Saves and data operations are temporarily disabled until reset.";
      }
      return err;
    }
  };

  return (
    <div className="h-screen w-full bg-[#050505] text-slate-100 font-sans flex flex-col overflow-hidden select-none">
      <Toaster position="top-center" />
      
      {/* Cookie Blocked Warning */}
      {isCookieBlocked && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[110] w-full max-w-md px-4 pointer-events-none">
          <div className="bg-red-500/90 backdrop-blur-md text-white p-4 rounded-2xl shadow-2xl flex items-start gap-4 border border-red-400/50 pointer-events-auto">
            <div className="bg-white/20 p-2 rounded-xl">
              <Info size={20} />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-sm">Cookie Blocked (Iframe)</h3>
              <p className="text-xs opacity-90 leading-tight mt-1">
                Your browser is blocking cookies in this iframe. Large uploads and high-quality renders will fail.
              </p>
            </div>
            <button 
              onClick={() => window.open(window.location.href, "_blank")}
              className="bg-white text-red-600 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase hover:bg-slate-100 transition-colors self-center whitespace-nowrap"
            >
              Open in New Tab
            </button>
          </div>
        </div>
      )}
      {/* Header */}
      <header className="h-16 border-b border-white/10 flex items-center justify-between px-4 md:px-8 bg-black/20 flex-shrink-0 z-40 relative">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="md:hidden p-2 text-slate-400 hover:text-white transition-colors"
          >
            <LayoutGrid size={20} />
          </button>
          <div className="w-8 h-8 md:w-10 md:h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <MonitorPlay size={18} className="text-white" />
          </div>
          <div className="flex flex-col min-w-0">
            <h1 className="text-base md:text-lg font-medium tracking-tight truncate">
              {getAppVersionTitle().replace("_", " ")}
            </h1>
            <span className="text-[10px] text-slate-500 font-mono truncate">
              {getAppUpdateLabel()}
            </span>
          </div>
          <div className="ml-4 md:ml-6 flex items-center bg-black/40 p-1 rounded-lg border border-white/5">
            <button
              onClick={() => setViewMode("editor")}
              className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all ${viewMode === "editor" ? "bg-indigo-600 text-white shadow-lg" : "text-slate-500 hover:text-slate-300"}`}
            >
              Studio
            </button>
            <button
              onClick={() => setViewMode("downloader")}
              className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md transition-all ${viewMode === "downloader" ? "bg-emerald-600 text-white shadow-lg" : "text-slate-500 hover:text-slate-300"}`}
            >
              Automation
            </button>
          </div>
          <span
            className="hidden lg:inline-block px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 text-[10px] font-mono font-bold border border-indigo-500/20"
            title={getAppUpdateLabel()}
          >
            Ver {APP_VERSION}
          </span>
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 text-slate-500 hover:text-indigo-400 transition-colors"
            title="System Settings"
          >
            <Settings size={16} />
          </button>
          <div className="flex items-center gap-2 md:gap-3">
            <span className="hidden sm:inline-block text-xs text-slate-400 font-mono">
              {appUsername}
            </span>
            <button
              onClick={handleAppLogout}
              className="px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-slate-300 hover:text-red-400 hover:border-red-500/30 transition-colors flex items-center gap-1.5"
              title="Đăng xuất"
            >
              <LogOut size={14} />
              <span className="hidden md:inline">Đăng xuất</span>
            </button>
          </div>
          <a
            href="https://www.storyblocks.com/"
            target="_blank"
            rel="noreferrer"
            className="p-2 md:px-4 md:py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm font-medium hover:bg-white/10 transition-colors flex items-center gap-2"
          >
            <Search size={14} />
            <span className="hidden md:inline">Storyblocks</span>
          </a>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden relative">
        {/* Mobile Sidebar Overlay */}
        {isSidebarOpen && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 md:hidden"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}

        {/* Projects Sidebar */}
        <aside
          className={`
          fixed md:static inset-y-0 left-0 w-64 border-r border-white/10 bg-[#0a0a0c] z-40 transition-transform duration-300 transform 
          ${isSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
          flex flex-col flex-shrink-0
        `}
        >
            <div className="p-4 border-b border-white/5">
              <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-4">
                Projects
              </h2>
              <form onSubmit={handleCreateProject} className="flex gap-2">
                <input
                  type="text"
                  value={newProjectTitle}
                  onChange={(e) => setNewProjectTitle(e.target.value)}
                  placeholder="New project..."
                  className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs outline-none text-white focus:border-indigo-500/50"
                  disabled={isCreatingProject}
                />
                <button
                  type="submit"
                  disabled={isCreatingProject || !newProjectTitle.trim()}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white rounded px-2 py-1.5 disabled:opacity-50 transition-colors"
                >
                  <Plus size={14} />
                </button>
              </form>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
              {projects.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500 italic">
                  No projects yet.
                </div>
              ) : (
                projects.map((proj) => {
                  const projStatus = resolveProjectStatus(proj);
                  const createdLabel = formatProjectCreatedAtVi(proj.createdAt);
                  const statusIconClass =
                    projStatus === "completed"
                      ? "text-emerald-400"
                      : "text-amber-400";
                  const statusTitle =
                    projStatus === "completed"
                      ? "Hoàn thành"
                      : "Đang chỉnh sửa";
                  return (
                  <div
                    key={proj.id}
                    onClick={() => setSelectedProjectId(proj.id)}
                    title={statusTitle}
                    className={`group flex items-center justify-between gap-1 px-2 py-1.5 rounded cursor-pointer transition-colors ${selectedProjectId === proj.id ? "bg-indigo-500/20" : "hover:bg-white/5"}`}
                  >
                    <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
                      {selectedProjectId === proj.id ? (
                        <FolderOpen
                          size={14}
                          className={`flex-shrink-0 ${statusIconClass}`}
                        />
                      ) : (
                        <Folder
                          size={14}
                          className={`flex-shrink-0 ${statusIconClass}`}
                        />
                      )}
                      <div className="min-w-0 flex-1 leading-tight">
                      {editingProjectId === proj.id ? (
                        <input
                          autoFocus
                          className="bg-black/40 border border-indigo-500/50 rounded px-1 text-xs w-full outline-none text-white"
                          value={editingProjectTitle}
                          onChange={(e) =>
                            setEditingProjectTitle(e.target.value)
                          }
                          onBlur={() => handleUpdateProjectTitle()}
                          onKeyDown={(e) =>
                            e.key === "Enter" && handleUpdateProjectTitle()
                          }
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <>
                          <span
                            className={`text-xs truncate block font-medium ${selectedProjectId === proj.id ? "text-indigo-200" : "text-slate-300"}`}
                          >
                            {proj.title}
                          </span>
                          {createdLabel ? (
                            <span
                              className={`text-[9px] truncate block ${selectedProjectId === proj.id ? "text-indigo-300/60" : "text-slate-500"}`}
                            >
                              {createdLabel}
                            </span>
                          ) : null}
                        </>
                      )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                      <button
                        onClick={(e) => startEditingProject(proj, e)}
                        className="text-slate-500 hover:text-indigo-400 p-1.5 cursor-pointer"
                        title="Edit title"
                      >
                        <FileText size={14} />
                      </button>
                      <button
                        onClick={(e) => handleDeleteProject(proj.id, e)}
                        className="text-slate-500 hover:text-red-400 p-1.5 rounded cursor-pointer"
                        title="Delete project"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  );
                })
              )}
            </div>
          </aside>

        {/* Main Content Area */}
        {viewMode === "editor" ? (
          <>
            {/* Mobile Tabs */}
            <div className="md:hidden absolute top-0 left-0 right-0 h-10 border-b border-white/10 bg-black/40 flex z-20">
              <button
                onClick={() => setActiveTab("script")}
                className={`flex-1 text-[10px] uppercase font-bold tracking-widest transition-colors ${activeTab === "script" ? "text-indigo-400 border-b-2 border-indigo-500" : "text-slate-500"}`}
              >
                Kịch bản
              </button>
              <button
                onClick={() => setActiveTab("preview")}
                className={`flex-1 text-[10px] uppercase font-bold tracking-widest transition-colors ${activeTab === "preview" ? "text-indigo-400 border-b-2 border-indigo-500" : "text-slate-500"}`}
              >
                Xem trước
              </button>
            </div>

        {/* Source Script Area */}
        <section
          className={`
          w-full md:w-[400px] border-r border-white/10 flex flex-col bg-black/10 flex-shrink-0 transition-all pt-10 md:pt-0
          ${activeTab === "script" ? "flex" : "hidden md:flex"}
          ${!selectedProjectId && "opacity-50 pointer-events-none"}
        `}
        >
          <div className="p-4 border-b border-white/5 flex justify-between items-center">
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
              Keywords / SRT Input
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isProcessing || !selectedProjectId}
                className="text-[9px] px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-slate-300 transition-colors flex items-center gap-1 uppercase tracking-wider font-bold disabled:opacity-50"
                title="Import SRT file"
              >
                <FileText size={10} /> SRT
              </button>
              <button
                type="button"
                onClick={openProjectStudioSetup}
                disabled={!selectedProjectId || isProcessing}
                className="text-[9px] px-2 py-1 rounded bg-violet-500/20 hover:bg-violet-500/35 text-violet-200 border border-violet-500/30 transition-colors flex items-center gap-1 uppercase tracking-wider font-bold disabled:opacity-50"
                title="Visual style, pacing & Storyblocks (theo dự án)"
              >
                <Palette size={10} />
                <span className="hidden sm:inline">Style</span>
              </button>
              <button
                onClick={() => audioInputRef.current?.click()}
                disabled={isProcessing || isTranscribing || !selectedProjectId}
                className="text-[9px] px-2 py-1 rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 transition-colors flex items-center gap-1 uppercase tracking-wider font-bold disabled:opacity-50"
                title="Import MP3 for auto-transcription"
              >
                {isTranscribing ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Play size={10} />
                )}{" "}
                MP3
              </button>
              <input
                type="file"
                accept=".srt"
                hidden
                ref={fileInputRef}
                onChange={handleImportSRT}
              />
              <input
                type="file"
                accept="audio/*"
                hidden
                ref={audioInputRef}
                onChange={handleImportMP3}
              />
            </div>
          </div>
          <div className="flex-1 p-4 md:p-6 overflow-y-auto text-sm leading-relaxed text-slate-300 font-serif italic">
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder={
                selectedProjectId
                  ? "Nhập danh sách keyword, mỗi keyword 1 dòng...\nHoặc dán SRT / import MP3. Nút Style cạnh SRT để chỉnh hình ảnh & pacing."
                  : "Create or select a project to begin..."
              }
              className="w-full min-h-[280px] md:min-h-[360px] resize-y outline-none bg-transparent placeholder:opacity-50"
              disabled={isProcessing || !selectedProjectId}
            />
          </div>
          <div className="p-4 border-t border-white/5 bg-black/20">
            {error && (
              <div className="bg-red-500/10 text-red-400 p-3 rounded-lg text-xs mb-4 border border-red-500/20">
                {formatError(error)}
              </div>
            )}
            <button
              onClick={handleProcessScript}
              disabled={isProcessing || !script.trim()}
              className="w-full px-4 py-3 rounded-lg bg-indigo-600 text-sm font-medium shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 transition-colors flex items-center justify-center gap-2"
            >
              {isProcessing ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Đang xử lý...
                </>
              ) : /^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/m.test(
                  script,
                ) ? (
                <>Phân tích SRT & Đề xuất Keywords</>
              ) : (
                <>Phân tích Keywords & Tìm Video</>
              )}
            </button>
            {tokenUsage && (
              <div className="mt-4 bg-white/5 border border-white/10 rounded-lg p-3 text-[11px] text-slate-300 font-mono shadow-sm">
                <div className="flex justify-between items-center mb-3">
                  <span className="uppercase tracking-widest text-slate-400 font-bold text-[10px]">
                    Token Breakdown
                  </span>
                  <span className="text-indigo-400 font-bold text-sm">
                    {tokenUsage.totalTokenCount.toLocaleString()} t
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-3">
                  <div className="flex flex-col relative group">
                    <span className="text-slate-500 uppercase tracking-wider text-[9px] font-bold">
                      Prompt
                    </span>
                    <span className="text-white font-medium">
                      {tokenUsage.promptTokenCount.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex flex-col relative group">
                    <span className="text-slate-500 uppercase tracking-wider text-[9px] font-bold">
                      Response
                    </span>
                    <span className="text-white font-medium">
                      {tokenUsage.candidatesTokenCount.toLocaleString()}
                    </span>
                  </div>
                  {tokenUsage.thoughtsTokenCount > 0 && (
                    <div className="flex flex-col relative group bg-indigo-500/5 p-1 rounded">
                      <span className="text-indigo-400/70 uppercase tracking-wider text-[9px] font-bold">
                        Thinking
                      </span>
                      <span className="text-indigo-300 font-medium">
                        {tokenUsage.thoughtsTokenCount.toLocaleString()}
                      </span>
                    </div>
                  )}
                  {tokenUsage.cachedContentTokenCount > 0 && (
                    <div className="flex flex-col relative group">
                      <span className="text-slate-500 uppercase tracking-wider text-[9px] font-bold">
                        Cached
                      </span>
                      <span className="text-white font-medium">
                        {tokenUsage.cachedContentTokenCount.toLocaleString()}
                      </span>
                    </div>
                  )}
                  <div className="flex flex-col relative group">
                    <span className="text-slate-500 uppercase tracking-wider text-[9px] font-bold">
                      Tool / System
                    </span>
                    <span className="text-white font-medium">
                      {tokenUsage.toolUsePromptTokenCount.toLocaleString()}
                    </span>
                    <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block bg-slate-800 text-white p-2 rounded text-[10px] z-50 w-48 shadow-lg border border-slate-700">
                      Token được dùng cho hướng dẫn hệ thống / gọi hàm.
                    </div>
                  </div>

                  {(() => {
                    const other =
                      tokenUsage.totalTokenCount -
                      tokenUsage.promptTokenCount -
                      tokenUsage.candidatesTokenCount -
                      tokenUsage.thoughtsTokenCount -
                      tokenUsage.cachedContentTokenCount -
                      tokenUsage.toolUsePromptTokenCount;
                    return (
                      <div className="flex flex-col relative group">
                        <span className="text-slate-500 uppercase tracking-wider text-[9px] font-bold">
                          Other / Hidden
                        </span>
                        <span className="text-rose-400 font-medium">
                          {other.toLocaleString()}
                        </span>
                        <div className="absolute bottom-full right-0 mb-1 hidden group-hover:block bg-slate-800 text-white p-2 rounded text-[10px] z-50 w-48 shadow-lg border border-slate-700">
                          Lượng token chênh lệch do system instruction, schema
                          nội bộ hoặc padding billing.
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {(() => {
                  const other =
                    tokenUsage.totalTokenCount -
                    tokenUsage.promptTokenCount -
                    tokenUsage.candidatesTokenCount -
                    tokenUsage.thoughtsTokenCount -
                    tokenUsage.cachedContentTokenCount -
                    tokenUsage.toolUsePromptTokenCount;
                  if (
                    other > 0 ||
                    tokenUsage.totalTokenCount !==
                      tokenUsage.promptTokenCount +
                        tokenUsage.candidatesTokenCount
                  ) {
                    return (
                      <div className="mt-2 mb-2 text-[10px] text-orange-300 text-center opacity-80 italic leading-snug border-t border-white/5 pt-2">
                        * Total token count ({tokenUsage.totalTokenCount}) bao
                        gồm các thành phần ẩn (thinking, cache, metadata) -
                        Không chỉ là Input + Output.
                      </div>
                    );
                  }
                  return null;
                })()}

                <div className="mt-3 pt-3 border-t border-white/5">
                  <span className="uppercase tracking-widest text-slate-500 font-bold text-[9px] mb-2 block">
                    Tokens By Stage
                  </span>
                  <div className="space-y-1.5 flex flex-col">
                    {Object.entries(tokenUsageByStage).map(
                      ([stageName, usage]: [string, any]) => (
                        <div
                          key={stageName}
                          className="flex justify-between items-center text-[10px]"
                        >
                          <span className="text-slate-400 font-medium truncate pr-2 capitalize">
                            {stageName.replace(/_/g, " ")}
                          </span>
                          <div className="flex gap-2 shrink-0">
                            <span
                              className="text-slate-500"
                              title="Thinking Tokens"
                            >
                              {usage.thoughtsTokenCount > 0 &&
                                `(Think: ${usage.thoughtsTokenCount})`}
                            </span>
                            <span className="text-indigo-300/80 font-bold">
                              {usage.totalTokenCount.toLocaleString()} t
                            </span>
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Results Section */}
        <section
          className={`
          flex-1 min-w-0 flex flex-col relative bg-[#0e0e11]/50 pt-10 md:pt-0
          ${activeTab === "preview" ? "flex" : "hidden md:flex"}
          ${!selectedProjectId && "opacity-50 pointer-events-none"}
        `}
        >
          <div className="p-3 md:p-4 border-b border-white/5 flex flex-wrap gap-2 justify-between items-center bg-black/40">
            <div className="flex items-center gap-2">
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Preview
              </h2>
              {selectedProjectId && (
                <>
                  <span className="text-slate-700 mx-1">/</span>
                  <span className="text-[10px] text-indigo-300/80 font-medium truncate max-w-[120px] md:max-w-[200px]">
                    {projects.find((p) => p.id === selectedProjectId)?.title ||
                      "..."}
                  </span>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 md:gap-2">
              {scenes.length > 0 && (
                <>
                  {sceneMergeSelection.length >= 2 && (
                    <button
                      type="button"
                      onClick={handleMergeSelectedScenes}
                      className="px-2 py-1 md:px-3 md:py-1 text-[9px] md:text-[10px] bg-violet-600/20 text-violet-300 hover:bg-violet-600/35 border border-violet-500/40 rounded flex items-center gap-1 md:gap-1.5 font-bold transition-colors uppercase tracking-wider"
                    >
                      <GitMerge size={10} className="md:w-3 md:h-3" />
                      Gộp {sceneMergeSelection.length} phân cảnh
                    </button>
                  )}
                  {sceneMergeSelection.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSceneMergeSelection([])}
                      className="px-2 py-1 text-[9px] text-slate-400 hover:text-white border border-white/10 rounded uppercase tracking-wider"
                    >
                      Bỏ chọn
                    </button>
                  )}
                  <button
                    onClick={() => saveProjectState(script, scenes, true)}
                    disabled={isSaving}
                    className={`px-2 py-1 md:px-3 md:py-1 text-[9px] md:text-[10px] border rounded flex items-center gap-1 md:gap-1.5 font-bold transition-all uppercase tracking-wider disabled:opacity-50 relative ${
                      isDirty
                        ? "bg-amber-600/20 text-amber-400 border-amber-500/50 hover:bg-amber-600/30"
                        : "bg-indigo-600/20 text-indigo-400 border-indigo-500/30 hover:bg-indigo-600/40"
                    }`}
                  >
                    {isSaving ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Save size={10} className="md:w-3 md:h-3" />
                    )}
                    <span className="hidden sm:inline">
                      {isSaving ? "Saving..." : "Save"}
                    </span>
                    {!isSaving && <span className="sm:hidden">Save</span>}
                    {isDirty && !isSaving && (
                      <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(245,158,11,0.8)]" />
                    )}
                  </button>

                </>
              )}
              {isProcessing && (
                <span className="flex items-center gap-1.5 text-[10px] bg-green-500/20 text-green-400 px-2 py-1 rounded-full border border-green-500/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></div>{" "}
                  Browser Engine Active
                </span>
              )}
            </div>
          </div>

          <div className="flex-1 p-6 overflow-y-auto">
            {scenes.length === 0 && !isProcessing && (
              <div className="h-full flex flex-col items-center justify-center text-slate-600 opacity-30 space-y-4">
                <LayoutGrid size={48} strokeWidth={1} />
                <p className="text-sm font-mono tracking-widest">
                  {selectedProjectId
                    ? "AWAITING KEYWORDS"
                    : "SELECT OR CREATE A PROJECT"}
                </p>
              </div>
            )}

            {scenes.length > 0 && (
              <div className="grid grid-cols-1 gap-6 content-start mb-6">
                {scenes.map((scene, idx) => (
                  <div
                    id={`scene-card-${idx}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.1 }}
                    key={idx}
                    className={`relative group ${scene.loadingVideos ? "opacity-60 grayscale" : ""} ${sceneMergeSelection.includes(idx) ? "ring-2 ring-violet-500/60 rounded-xl" : ""}`}
                  >
                    <div className="absolute -inset-0.5 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-xl blur opacity-0 group-hover:opacity-20 transition duration-500"></div>
                    <label className="absolute top-2 left-2 z-10 flex items-center gap-1.5 cursor-pointer bg-black/60 backdrop-blur px-2 py-1 rounded-md border border-white/10 hover:border-violet-500/40 transition-colors">
                      <input
                        type="checkbox"
                        checked={sceneMergeSelection.includes(idx)}
                        onChange={() => toggleSceneMergeSelection(idx)}
                        className="rounded border-white/20 bg-white/5 text-violet-500 focus:ring-violet-500/30 w-3 h-3"
                      />
                      <span className="text-[8px] uppercase font-bold text-slate-400 tracking-wider">
                        Gộp
                      </span>
                    </label>
                    <div
                      className={`relative ${scene.loadingVideos ? "bg-white/5 border border-white/5" : "bg-[#0e0e11] border border-white/10"} rounded-xl p-3 md:p-4 pt-8 flex flex-col lg:flex-row gap-4 md:gap-6`}
                    >
                      {/* Video Selection */}
                      <div className="w-full lg:w-64 flex-shrink-0 flex flex-col gap-3">
                        <div className="w-full aspect-video rounded-lg bg-slate-800 overflow-hidden relative border border-white/5 shadow-inner">
                          {scene.loadingVideos ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-indigo-400/50">
                              <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse mb-2"></div>
                              <span className="font-mono text-[9px]">
                                Scanning Storyblocks...
                              </span>
                            </div>
                          ) : scene.videos && scene.videos?.length > 0 ? (
                            <>
                              <video
                                key={`${idx}-${scene.selectedVideoIdx}`}
                                src={scene.videos[scene.selectedVideoIdx]?.url}
                                controls
                                className="w-full h-full object-cover group-hover:opacity-100 transition-opacity"
                                preload="auto"
                              />
                              <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-full bg-indigo-600/90 text-[8px] font-bold text-white border border-indigo-400/50">
                                #{scene.selectedVideoIdx + 1}
                              </div>
                            </>
                          ) : (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 p-2 text-center text-[9px] bg-black/40">
                              <Info size={16} className="mb-1 opacity-40" />
                              No results found
                              <a
                                href={`https://www.storyblocks.com/video/search?searchTerm=${encodeURIComponent(scene.keyword)}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-blue-400 hover:underline mt-1"
                              >
                                Try manual search
                              </a>
                            </div>
                          )}
                        </div>

                        {/* Rich Choice List */}
                        {!scene.loadingVideos &&
                          scene.videos &&
                          scene.videos.length > 0 && (
                            <div className="flex flex-col gap-1.5">
                              <div className="flex justify-between items-center px-1">
                                <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">
                                  Options
                                </span>
                                <span className="text-[9px] bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/20">
                                  {scene.videos?.length || 0}
                                </span>
                              </div>
                              <div className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-y-auto lg:max-h-40 pb-1 lg:pb-0 custom-scrollbar">
                                {scene.videos.map((v, vIdx) => (
                                  <button
                                    key={vIdx}
                                    onClick={() => handleSelectVideo(idx, vIdx)}
                                    className={`min-w-[100px] lg:min-w-0 px-2.5 py-2 rounded-lg text-[10px] text-left transition-all border flex flex-col gap-0.5 ${
                                      scene.selectedVideoIdx === vIdx
                                        ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-100 ring-1 ring-indigo-500/20"
                                        : "bg-white/5 border-white/5 text-slate-400 hover:bg-white/10 hover:border-white/10"
                                    }`}
                                  >
                                    <div className="flex justify-between items-start w-full gap-2">
                                      <span
                                        className={`font-bold ${scene.selectedVideoIdx === vIdx ? "text-indigo-400" : "text-slate-500"}`}
                                      >
                                        #{vIdx + 1}
                                      </span>
                                      {scene.selectedVideoIdx === vIdx && (
                                        <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-1"></div>
                                      )}
                                    </div>
                                    <span
                                      className="opacity-70 truncate w-full text-[9px] italic"
                                      title={v?.title || ""}
                                    >
                                      {v?.title || "Unnamed Video"}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                      </div>

                      {/* Text Content */}
                      <div className="flex-1 min-w-0 flex flex-col justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-2">
                            <h3
                              className={`text-sm font-semibold truncate ${scene.loadingVideos ? "text-slate-300" : "text-indigo-300"}`}
                            >
                              Scene {idx + 1 < 10 ? `0${idx + 1}` : idx + 1}
                            </h3>
                            {scene.isMerged && (
                              <span className="text-[9px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border border-violet-500/30 bg-violet-500/10 text-violet-300">
                                Đã gộp
                                {scene.mergedFromIds && scene.mergedFromIds.length > 1
                                  ? ` ×${scene.mergedFromIds.length}`
                                  : ""}
                              </span>
                            )}
                            {scene.srtContext?.pacingZone && (
                              <span className="text-[9px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border border-white/10 bg-white/5 text-slate-400">
                                {scene.srtContext.pacingZone}
                              </span>
                            )}
                            <span className="text-[10px] font-mono text-slate-500 ml-auto">
                              {scene.loadingVideos
                                ? "Searching..."
                                : scene.videos && scene.videos.length > 0
                                  ? `sb: ${scene.videos.length}`
                                  : "sb: 0"}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-2 mb-3 items-center">
                            <div className="flex items-center gap-1 bg-white/5 border border-white/10 px-2 py-0.5 rounded focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500 transition-all">
                              <Search size={10} className="text-slate-400" />
                              <input
                                type="text"
                                defaultValue={scene.keyword}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    const val = e.currentTarget.value.trim();
                                    if (val && val !== scene.keyword) {
                                      refetchSceneVideos(idx, val);
                                    }
                                  }
                                }}
                                onBlur={(e) => {
                                  const val = e.currentTarget.value.trim();
                                  if (val && val !== scene.keyword) {
                                    refetchSceneVideos(idx, val);
                                  }
                                }}
                                className="bg-transparent text-[10px] outline-none text-white w-32 placeholder:text-slate-500"
                                placeholder="Edit keyword..."
                                disabled={scene.loadingVideos}
                              />
                            </div>
                            {!scene.loadingVideos &&
                              scene.videos &&
                              scene.videos?.length > 0 && (
                                <>
                                  <a
                                    href={
                                      scene.videos[scene.selectedVideoIdx]
                                        .stockUrl ||
                                      scene.videos[scene.selectedVideoIdx].url
                                    }
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[9px] bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/40 border border-indigo-500/30 px-2 py-0.5 rounded flex items-center gap-1 uppercase tracking-wider transition-colors"
                                  >
                                    <Play size={10} fill="currentColor" /> Source
                                  </a>
                                </>
                              )}
                            {scene.isMerged && (
                              <button
                                type="button"
                                onClick={() => handleRegenerateKeywordsEN(idx)}
                                disabled={
                                  scene.loadingVideos ||
                                  regeneratingKeywordsIdx === idx
                                }
                                className="text-[9px] bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 border border-emerald-500/30 px-2 py-0.5 rounded flex items-center gap-1 uppercase tracking-wider transition-colors disabled:opacity-50"
                              >
                                {regeneratingKeywordsIdx === idx ? (
                                  <Loader2 size={10} className="animate-spin" />
                                ) : (
                                  <Sparkles size={10} />
                                )}
                                Render lại keywords EN
                              </button>
                            )}
                          </div>
                        </div>

                        <p
                          className={`text-[12px] leading-relaxed text-slate-300 italic ${!scene.loadingVideos ? "border-l-2 border-indigo-500 pl-3 bg-indigo-500/5 rounded-r py-1.5 mb-2" : "mb-2"}`}
                        >
                          {scene.text}
                        </p>
                        {scene.srtContext?.summaryVi ? (
                          <p className="text-[11px] leading-snug text-slate-500 mb-2 border-l border-amber-500/40 pl-2 not-italic">
                            <span className="text-[9px] font-bold uppercase text-amber-600/90 mr-1">
                              Ghi chú màn hình (VI)
                            </span>
                            {scene.srtContext.summaryVi}
                          </p>
                        ) : null}

                        {scene.srtContext &&
                          (() => {
                            const displayKw = topStoryblocksKeywordsForScene(
                              scene.srtContext,
                              scene.keyword,
                            );
                            if (displayKw.length === 0) return null;
                            return (
                              <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-white/5">
                                <span className="text-[9px] text-slate-500 uppercase font-bold mr-1 self-center truncate">
                                  Keywords EN (Storyblocks):
                                </span>
                                {displayKw.map((kw: string) => (
                                  <button
                                    key={kw}
                                    onClick={() => refetchSceneVideos(idx, kw)}
                                    disabled={scene.loadingVideos}
                                    className={`text-[9px] px-2 py-0.5 rounded-full border transition-colors truncate max-w-[160px] ${scene.keyword === kw ? "bg-indigo-600 border-indigo-500 text-white" : "bg-white/5 border-white/10 text-slate-400 hover:bg-white/10 disabled:opacity-50 disabled:hover:bg-white/5 shadow-sm"}`}
                                    title={kw}
                                  >
                                    {kw}
                                  </button>
                                ))}
                                <span className="text-[9px] text-slate-500 font-mono self-center ml-auto border border-white/5 px-1 bg-black/20 rounded truncate max-w-[120px]">
                                  [{scene.srtContext.startTime} →{" "}
                                  {scene.srtContext.endTime}] ·{" "}
                                  {scene.srtContext.duration?.toFixed(1)}s
                                </span>
                              </div>
                            );
                          })()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Stitched Preview Timeline - Always show if scenes exist */}
          {scenes.length > 0 && (
            <TimelinePreview
              scenes={scenes}
              setScenes={setScenes}
              setIsDirty={setIsDirty}
              audioUrl={audioUrl}
            />
          )}
        </section>
      </>
    ) : (
      <AutomationDownloader 
        projectId={selectedProjectId!}
        projectRecord={projects.find((p) => p.id === selectedProjectId) ?? null}
        scenes={scenes}
        config={config}
        onConnectDrive={handleConnectDrive}
        onClose={() => setViewMode("editor")}
        onUpdateScenes={(updatedScenes: any) => {
          setScenes(updatedScenes);
          setIsDirty(true);
        }}
        onMerge={(res: string) => handleAutomationMerge(selectedProjectId!, scenes, res)}
        mergeJobId={mergeJobId}
        onMergeJobClear={() => setMergeJobId(null)}
        onProjectPatch={(updated) => {
          setProjects((prev) =>
            prev.map((p) => (p.id === updated.id ? updated : p)),
          );
        }}
      />
    )}
  </main>

      {/* Popup: Visual style & pacing (per project) */}
      {isProjectStudioSetupOpen && selectedProjectId && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-md z-[105] flex items-center justify-center p-4"
          role="presentation"
          onClick={cancelProjectStudioSetup}
        >
          <div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-lg max-h-[92vh] bg-[#0c0c0f] border border-violet-500/20 rounded-2xl shadow-2xl shadow-violet-950/40 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-white/10 flex justify-between items-start gap-3 bg-gradient-to-r from-violet-950/40 to-transparent">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-violet-300">
                  <Palette size={18} />
                  <h2 className="text-sm font-bold uppercase tracking-widest">
                    Style &amp; Pacing
                  </h2>
                </div>
                <p className="text-[11px] text-slate-500 mt-1 truncate">
                  Dự án:{" "}
                  <span className="text-slate-200 font-medium">
                    {projects.find((p) => p.id === selectedProjectId)?.title ||
                      selectedProjectId}
                  </span>
                </p>
                <p className="text-[10px] text-slate-600 mt-2 leading-snug">
                  Cấu hình được lưu cùng dự án; dùng khi phân tích SRT / tìm
                  Storyblocks.
                </p>
              </div>
              <button
                type="button"
                onClick={cancelProjectStudioSetup}
                className="p-2 hover:bg-white/5 rounded-lg text-slate-500 hover:text-white shrink-0"
                aria-label="Đóng"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-4 overflow-y-auto custom-scrollbar space-y-5 text-slate-300 min-h-0 flex-1">
              <label className="block space-y-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  Visual Style / Keyword Direction
                </span>
                <textarea
                  value={studioDraftVisual}
                  onChange={(e) => setStudioDraftVisual(e.target.value)}
                  placeholder="Ví dụ: video giáo dục cao cấp, truyền cảm hứng, tự nhiên, ấm áp. Ưu tiên hình ảnh học sinh, giáo viên, trường học xanh, thiên nhiên, lớp học hiện đại, cảm giác phát triển bền vững. Tránh hình ảnh classroom phương Tây quá generic, hoạt hình, footage chất lượng thấp, cảnh văn phòng corporate không liên quan."
                  rows={5}
                  className="w-full text-[12px] leading-relaxed bg-black/40 border border-white/10 rounded-xl p-3 text-slate-200 outline-none focus:border-violet-500/50 resize-y min-h-[100px] placeholder:text-slate-600"
                />
                <p className="text-[10px] text-slate-600">
                  AI dùng để sinh keyword tiếng Anh (stock search), fallback và
                  avoid terms.
                </p>
              </label>

              <div className="rounded-xl border border-white/10 bg-black/25 p-3 space-y-2">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Pacing &amp; Storyblocks
                </h3>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400">
                  <label className="flex flex-col gap-0.5">
                    Hook max (s)
                    <input
                      type="number"
                      min={2}
                      max={30}
                      value={studioDraftPacing.hookSceneMaxSec}
                      onChange={(e) =>
                        setStudioDraftPacing((p) => ({
                          ...p,
                          hookSceneMaxSec: Math.max(
                            2,
                            Number(e.target.value) || p.hookSceneMaxSec,
                          ),
                        }))
                      }
                      className="bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    Hook min (s)
                    <input
                      type="number"
                      min={2}
                      max={20}
                      value={studioDraftPacing.hookSceneMinSec}
                      onChange={(e) =>
                        setStudioDraftPacing((p) => ({
                          ...p,
                          hookSceneMinSec: Math.max(
                            2,
                            Number(e.target.value) || p.hookSceneMinSec,
                          ),
                        }))
                      }
                      className="bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    Body min (s)
                    <input
                      type="number"
                      min={5}
                      max={90}
                      value={studioDraftPacing.bodySceneMinSec}
                      onChange={(e) =>
                        setStudioDraftPacing((p) => ({
                          ...p,
                          bodySceneMinSec: Math.max(
                            5,
                            Number(e.target.value) || p.bodySceneMinSec,
                          ),
                        }))
                      }
                      className="bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    Body max (s)
                    <input
                      type="number"
                      min={5}
                      max={120}
                      value={studioDraftPacing.bodySceneMaxSec}
                      onChange={(e) =>
                        setStudioDraftPacing((p) => ({
                          ...p,
                          bodySceneMaxSec: Math.max(
                            5,
                            Number(e.target.value) || p.bodySceneMaxSec,
                          ),
                        }))
                      }
                      className="bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    Ending min (s)
                    <input
                      type="number"
                      min={3}
                      max={30}
                      value={studioDraftPacing.endingSceneMinSec}
                      onChange={(e) =>
                        setStudioDraftPacing((p) => ({
                          ...p,
                          endingSceneMinSec: Math.max(
                            3,
                            Number(e.target.value) || p.endingSceneMinSec,
                          ),
                        }))
                      }
                      className="bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    Ending max (s)
                    <input
                      type="number"
                      min={3}
                      max={40}
                      value={studioDraftPacing.endingSceneMaxSec}
                      onChange={(e) =>
                        setStudioDraftPacing((p) => ({
                          ...p,
                          endingSceneMaxSec: Math.max(
                            3,
                            Number(e.target.value) || p.endingSceneMaxSec,
                          ),
                        }))
                      }
                      className="bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    Đoạn cuối (s)
                    <input
                      type="number"
                      min={10}
                      max={120}
                      value={studioDraftPacing.endingLastSec}
                      onChange={(e) =>
                        setStudioDraftPacing((p) => ({
                          ...p,
                          endingLastSec: Math.max(
                            10,
                            Number(e.target.value) || p.endingLastSec,
                          ),
                        }))
                      }
                      className="bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    Clip / phút max
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={studioDraftPacing.maxClipsPerMinute}
                      onChange={(e) =>
                        setStudioDraftPacing((p) => ({
                          ...p,
                          maxClipsPerMinute: Math.max(
                            1,
                            Number(e.target.value) || p.maxClipsPerMinute,
                          ),
                        }))
                      }
                      className="bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 col-span-2">
                    Tổng clip (~10 phút): min – max
                    <span className="text-[9px] text-slate-600 font-normal normal-case">
                      Cho phép {PACING_TOTAL_CLIPS_ABSOLUTE_MIN}–
                      {PACING_TOTAL_CLIPS_ABSOLUTE_MAX} clip (ước lượng video ~10
                      phút).
                    </span>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min={PACING_TOTAL_CLIPS_ABSOLUTE_MIN}
                        max={PACING_TOTAL_CLIPS_ABSOLUTE_MAX}
                        value={studioDraftPacing.maxTotalClips10MinMin}
                        onChange={(e) =>
                          setStudioDraftPacing((p) => {
                            const raw = Number(e.target.value);
                            const nextMin = Number.isFinite(raw)
                              ? raw
                              : p.maxTotalClips10MinMin;
                            return {
                              ...p,
                              ...clampTotalClipsRange(
                                nextMin,
                                p.maxTotalClips10MinMax,
                              ),
                            };
                          })
                        }
                        className="flex-1 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                        aria-label="Tổng clip tối thiểu"
                      />
                      <input
                        type="number"
                        min={PACING_TOTAL_CLIPS_ABSOLUTE_MIN}
                        max={PACING_TOTAL_CLIPS_ABSOLUTE_MAX}
                        value={studioDraftPacing.maxTotalClips10MinMax}
                        onChange={(e) =>
                          setStudioDraftPacing((p) => {
                            const raw = Number(e.target.value);
                            const nextMax = Number.isFinite(raw)
                              ? raw
                              : p.maxTotalClips10MinMax;
                            return {
                              ...p,
                              ...clampTotalClipsRange(
                                p.maxTotalClips10MinMin,
                                nextMax,
                              ),
                            };
                          })
                        }
                        className="flex-1 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                        aria-label="Tổng clip tối đa"
                      />
                    </div>
                  </label>
                  <label className="flex flex-col gap-0.5 col-span-2">
                    Storyblocks choices / keyword
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={studioDraftPacing.storyblocksChoicesPerKeyword}
                      onChange={(e) =>
                        setStudioDraftPacing((p) => ({
                          ...p,
                          storyblocksChoicesPerKeyword: Math.max(
                            1,
                            Number(e.target.value) ||
                              p.storyblocksChoicesPerKeyword,
                          ),
                        }))
                      }
                      className="bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 text-[12px]"
                    />
                  </label>
                  <label className="flex items-center gap-2 col-span-2 mt-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={studioDraftPacing.allowClipReuse}
                      onChange={(e) =>
                        setStudioDraftPacing((p) => ({
                          ...p,
                          allowClipReuse: e.target.checked,
                        }))
                      }
                      className="rounded border-white/20"
                    />
                    <span className="text-slate-400">Allow clip reuse (timeline)</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-white/10 flex flex-wrap justify-end gap-2 bg-black/40">
              <button
                type="button"
                onClick={cancelProjectStudioSetup}
                className="px-4 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-wider border border-white/15 text-slate-400 hover:bg-white/5"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={applyProjectStudioSetup}
                className="px-4 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-wider bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-900/40"
              >
                Lưu cho dự án
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full max-w-2xl bg-[#0e0e11] border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
          >
            <div className="p-4 border-b border-white/5 flex justify-between items-center bg-white/5">
              <div className="flex items-center gap-2">
                <Settings size={18} className="text-indigo-400" />
                <h2 className="text-sm font-bold uppercase tracking-widest text-slate-100">
                  System Configuration
                </h2>
              </div>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="p-2 hover:bg-white/5 rounded-lg transition-colors text-slate-400 font-bold"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-6 space-y-8 overflow-y-auto max-h-[70vh] custom-scrollbar text-slate-300">
              {/* Model Selection */}
              <section className="space-y-4">
                <div className="flex items-center gap-2 text-indigo-300">
                  <Cpu size={16} />
                  <h3 className="text-xs font-bold uppercase tracking-wider">
                    AI Model Selection
                  </h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[10px] text-slate-500 uppercase font-bold px-1">
                      Transcription Engine
                    </label>
                    <select
                      value={config.transcriptionModel}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          transcriptionModel: e.target.value,
                        })
                      }
                      className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm outline-none focus:border-indigo-500/50 transition-colors text-slate-100"
                    >
                      <option value="gemini-2.5-flash">
                        Gemini 2.5 Flash (khuyến nghị)
                      </option>
                      <option value="gemini-1.5-flash">
                        Gemini 1.5 Flash (legacy)
                      </option>
                      <option value="gemini-1.5-pro">
                        Gemini 1.5 Pro (chất lượng)
                      </option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] text-slate-500 uppercase font-bold px-1">
                      Analysis & Keywords
                    </label>
                    <select
                      value={config.analysisModel}
                      onChange={(e) =>
                        setConfig({ ...config, analysisModel: e.target.value })
                      }
                      className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm outline-none focus:border-indigo-500/50 transition-colors text-slate-100"
                    >
                      <option value="gemini-2.5-flash">
                        Gemini 2.5 Flash (cân bằng)
                      </option>
                      <option value="gemini-2.5-flash-lite">
                        Gemini 2.5 Flash Lite (ít token, khuyến nghị)
                      </option>
                      <option value="gemini-2.5-pro">
                        Gemini 2.5 Pro (ngữ cảnh sâu)
                      </option>
                      <option value="gemini-1.5-flash">
                        Gemini 1.5 Flash (legacy)
                      </option>
                      <option value="gemini-1.5-pro">
                        Gemini 1.5 Pro (legacy)
                      </option>
                    </select>
                  </div>
                </div>
              </section>

              {/* API Keys Settings */}
              <section className="space-y-4">
                <div className="flex items-center gap-2 text-amber-300">
                  <CreditCard size={16} />
                  <h3 className="text-xs font-bold uppercase tracking-wider">
                    API Credentials
                  </h3>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] text-slate-500 uppercase font-bold px-1 flex justify-between">
                      <span>Gemini API Key</span>
                      <span className="text-indigo-400 normal-case font-normal italic">
                        Leave empty to use system default
                      </span>
                    </label>
                    <div className="relative">
                      <input
                        type="password"
                        placeholder="Paste your Gemini API Key here..."
                        value={config.geminiApiKey}
                        onChange={(e) =>
                          setConfig({ ...config, geminiApiKey: e.target.value })
                        }
                        className="w-full bg-white/5 border border-white/10 rounded-lg p-3 pr-10 text-sm outline-none focus:border-indigo-500/50 transition-colors text-slate-100 font-mono"
                      />
                    </div>
                  </div>

                  <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <Info
                        size={16}
                        className="text-amber-400 mt-0.5 flex-shrink-0"
                      />
                      <div className="text-[10px] text-slate-400 leading-relaxed">
                        <p className="mb-1 text-amber-200">
                          Hệ thống đang gặp lỗi 429 (Hết tiền/Hạn mức)?
                        </p>
                        Mặc định hệ thống sử dụng Key chung. Nếu bạn bị lỗi
                        "prepayment credits are depleted", hãy nhập Key cá nhân
                        của bạn vào ô trên. Bạn có thể lấy Key miễn phí tại{" "}
                        <a
                          href="https://aistudio.google.com/app/apikey"
                          target="_blank"
                          rel="noreferrer"
                          className="text-indigo-400 underline"
                        >
                          Google AI Studio
                        </a>
                        .
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Advanced Settings */}
              <section className="space-y-4">
                <div className="flex items-center gap-2 text-green-300">
                  <Settings size={16} />
                  <h3 className="text-xs font-bold uppercase tracking-wider">
                    Advanced Settings
                  </h3>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] text-slate-500 uppercase font-bold px-1 flex justify-between">
                      <span>Storyblocks Session Cookies</span>
                      <span className="text-amber-400 normal-case font-normal italic">
                        Required for High-Quality Downloads
                      </span>
                    </label>
                    <textarea
                      placeholder="Paste your cookies string here from browser DevTools (format: cookie1=val1; cookie2=val2...)"
                      value={config.storyblocksCookies || ""}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          storyblocksCookies: e.target.value,
                        })
                      }
                      rows={3}
                      className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-[10px] outline-none focus:border-amber-500/50 transition-colors text-slate-100 font-mono resize-none custom-scrollbar"
                    />
                    <p className="text-[9px] text-slate-500 italic px-1">
                      Open Storyblocks, check Network tab in DevTools for any request, copy the 'Cookie' header value.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] text-slate-500 uppercase font-bold px-1 flex justify-between">
                      <span>Storyblocks Proxies</span>
                      <span className="text-indigo-400 normal-case font-normal italic">
                        One per line (IP:PORT:USER:PASS)
                      </span>
                    </label>
                    <textarea
                      placeholder="e.g. 14.187.228.145:29274:user:pass"
                      value={config.storyblocksProxies || ""}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          storyblocksProxies: e.target.value,
                        })
                      }
                      className="w-full h-24 bg-white/5 border border-white/10 rounded-lg p-3 text-sm outline-none focus:border-green-500/50 transition-colors text-slate-100 font-mono resize-none"
                    />
                    <p className="text-[9px] text-slate-500 px-1">
                      Adding proxies prevents your IP from being blocked by
                      Storyblocks. When configured, the server will pick a
                      random proxy for each scrape request.
                    </p>
                  </div>

                  <div className="space-y-2 mt-4 pt-2 border-t border-white/5">
                    <label className="text-[10px] text-slate-500 uppercase font-bold px-1 flex justify-between">
                      <span>Recent Proxy Usage History</span>
                      <span className="text-slate-400 font-normal">
                        {proxyLogs.length} logs
                      </span>
                    </label>
                    <div className="bg-[#09090b] border border-white/5 rounded-lg overflow-hidden max-h-48 overflow-y-auto custom-scrollbar">
                      {proxyLogs.length === 0 ? (
                        <div className="p-4 text-center text-xs text-slate-600">
                          No proxy logs yet. Run a search to see proxy usage.
                        </div>
                      ) : (
                        <div className="divide-y divide-white/5">
                          {proxyLogs.map((log) => (
                            <div
                              key={log.id}
                              className="p-2 px-3 flex flex-col gap-1 text-[11px] font-mono"
                            >
                              <div className="flex justify-between items-center">
                                <span
                                  className={
                                    log.status === "success"
                                      ? "text-green-400 font-medium"
                                      : "text-red-400 font-medium"
                                  }
                                >
                                  [{log.status.toUpperCase()}]{" "}
                                  {log.proxy || "No Proxy / Direct IP"}
                                </span>
                                <span className="text-slate-600 shrink-0 text-[10px]">
                                  {new Date(log.timestamp).toLocaleTimeString()}
                                </span>
                              </div>
                              <div className="flex justify-between items-center text-slate-400 text-[10px]">
                                <span className="truncate pr-2 w-2/3">
                                  Scraped: "{log.keyword}"
                                </span>
                                {log.status === "success" && (
                                  <span>Found: {log.videosFound}</span>
                                )}
                              </div>
                              {log.message && (
                                <div className="text-red-500/80 text-[10px] mt-1 break-words">
                                  {log.message}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              {/* System Info (Static) */}

              {/* System Health */}
              <section className="space-y-4">
                <div className="flex items-center gap-2 text-green-300">
                  <Activity size={16} />
                  <h3 className="text-xs font-bold uppercase tracking-wider">
                    Service Status
                  </h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-3 bg-white/5 border border-white/10 rounded-xl flex flex-col items-center gap-1 group hover:border-green-500/30 transition-colors">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse mb-1 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Firebase
                    </span>
                    <span className="text-[9px] text-green-400 font-bold">
                      CONNECTED
                    </span>
                  </div>
                  <div className="p-3 bg-white/5 border border-white/10 rounded-xl flex flex-col items-center gap-1 group hover:border-green-500/30 transition-colors">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse mb-1 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      GEMINI AI
                    </span>
                    <span className="text-[9px] text-green-400 font-bold">
                      OPERATIONAL
                    </span>
                  </div>
                  <div className="p-3 bg-white/5 border border-white/10 rounded-xl flex flex-col items-center gap-1 group hover:border-green-500/30 transition-colors">
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse mb-1 shadow-[0_0_8px_rgba(34,197,94,0.5)]"></div>
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      RENDERER
                    </span>
                    <span className="text-[9px] text-green-400 font-bold">
                      READY
                    </span>
                  </div>
                </div>
              </section>
            </div>

            <div className="px-4 py-2 border-t border-white/5 bg-black/30">
              <p className="text-[10px] font-mono text-slate-500 text-center">
                {getAppFullLabel()}
              </p>
            </div>
            <div className="p-4 border-t border-white/5 bg-white/5 flex gap-3">
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="flex-1 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg transition-colors text-xs uppercase tracking-widest shadow-lg shadow-indigo-600/20 active:scale-95"
              >
                Apply Configuration
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
