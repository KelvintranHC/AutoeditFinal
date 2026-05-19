import React, { useState, useEffect, useMemo } from "react";
import { 
  Loader2, CheckCircle2, XCircle, HardDrive, DownloadCloud, 
  Terminal, History, Key, Monitor, Play, FileText, Activity, 
  BarChart3, ShieldCheck, Zap, List as ListIcon, ArrowLeft, Copy,
  MonitorPlay, ExternalLink, Download, Link2, RefreshCw, Upload
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "react-hot-toast";
import { db, auth, handleFirestoreError, OperationType } from "../lib/firebase";
import { collection, query, getDocs, doc, setDoc, getDoc, serverTimestamp } from "firebase/firestore";
import { updateProjectApi } from "../lib/projectApi";
import type { Project } from "../lib/projectTypes";
import {
  DriveLinkActions,
  resolveDriveDirectLink,
  resolveDriveFileIdForVideo,
} from "./driveLinkActions";
import { MergedProjectOutput } from "./MergedProjectOutput";

function mergedExportBasenameFromUrl(url: string | undefined | null): string | null {
  if (!url || typeof url !== "string") return null;
  const seg = url.split("/").filter(Boolean).pop();
  const base = seg?.split("?")[0] ?? "";
  return /^drive_merge_mj_.+\.mp4$/i.test(base) ? base : null;
}

interface Job {
  id: string;
  stockUrl: string;
  stockTitle: string;
  status: "idle" | "downloading" | "uploading" | "success" | "error";
  diagnostic?: string;
  screenshot?: string;
  driveLink?: string;
  driveDirectLink?: string;
  driveFileId?: string;
  downloadDuration?: number;
  uploadDuration?: number;
  /** From server after download completes (bytes). */
  fileSizeBytes?: number;
  error?: string;
}

/**
 * Dựng bản sao scenes để merge: ưu tiên link/id Drive từ Queue (job SUCCESS).
 * Không phụ thuộc thư mục đích trong Auth — chỉ cần pipeline upload đã thành công.
 */
export function buildScenesForMergeFromQueue(
  scenes: any[] | undefined,
  jobs: Job[],
): any[] {
  const out = JSON.parse(JSON.stringify(scenes || [])) as any[];
  const successJobs = jobs.filter((j) => j.status === "success");
  if (!out.length || !successJobs.length) return out;

  for (const scene of out) {
    if (!Array.isArray(scene.videos)) continue;
    for (const v of scene.videos) {
      const job = successJobs.find(
        (j) => j.id === v.url || j.stockUrl === v.stockUrl,
      );
      if (!job) continue;
      const fid = resolveDriveFileIdForVideo({
        driveFileId: job.driveFileId,
        driveLink: job.driveLink,
        driveDirectLink: job.driveDirectLink,
      });
      if (!fid) continue;
      if (job.driveLink) v.driveLink = job.driveLink;
      v.driveFileId = job.driveFileId || fid;
      if (job.driveDirectLink) v.driveDirectLink = job.driveDirectLink;
    }
  }
  return out;
}

/** Clip gửi lên server reupload — gộp Queue SUCCESS + Drive trên scenes (timeline). */
export type ReuploadClipPayload = {
  id: string;
  stockUrl: string;
  stockTitle: string;
  driveFileId?: string;
  driveLink?: string;
  driveDirectLink?: string;
};

function buildReuploadClipsPayload(
  jobs: Job[],
  scenes: any[] | undefined,
  selectedVideos: { id: string; stockUrl: string; title: string }[],
): ReuploadClipPayload[] {
  const out: ReuploadClipPayload[] = [];
  const seenStock = new Set<string>();

  const push = (p: ReuploadClipPayload) => {
    const su = (p.stockUrl || "").trim();
    if (!su || seenStock.has(su)) return;
    const d = (p.driveDirectLink || "").trim();
    const hasHttpDirect =
      /^https?:\/\//i.test(d) &&
      (/drive\.google\.com/i.test(d) ||
        /drive\.usercontent\.google\.com/i.test(d));
    if (!resolveDriveFileIdForVideo(p) && !hasHttpDirect) return;
    seenStock.add(su);
    out.push({
      ...p,
      stockUrl: su,
      stockTitle: (p.stockTitle || "Video").trim() || "Video",
    });
  };

  for (const j of jobs) {
    if (j.status !== "success") continue;
    push({
      id: j.id,
      stockUrl: j.stockUrl,
      stockTitle: j.stockTitle,
      driveFileId: j.driveFileId,
      driveLink: j.driveLink,
      driveDirectLink: j.driveDirectLink,
    });
  }

  for (const clip of selectedVideos) {
    const su = (clip.stockUrl || "").trim();
    if (!su || seenStock.has(su)) continue;

    let v: any = null;
    for (const scene of scenes || []) {
      if (!scene.videos?.length) continue;
      for (const vid of scene.videos) {
        if (
          (vid.stockUrl && String(vid.stockUrl).trim() === su) ||
          (clip.id && vid.url === clip.id)
        ) {
          v = vid;
          break;
        }
      }
      if (v) break;
    }
    if (!v) continue;

    push({
      id: clip.id,
      stockUrl: su,
      stockTitle: clip.title || v.title || "Video",
      driveFileId: v.driveFileId,
      driveLink: v.driveLink,
      driveDirectLink: v.driveDirectLink,
    });
  }

  return out;
}

const LiveBrowser = ({ job, projectId }: { job: Job; projectId: string }) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [clicked, setClicked] = useState(false);

  const handleClick = async (e: React.MouseEvent) => {
    if (!containerRef.current || !job.screenshot) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    setClicked(true);
    setTimeout(() => setClicked(false), 300);

    try {
      await fetch("/api/downloader/interact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, x, y, type: "click" }),
      });
    } catch (err) {
      console.error("Interaction failed", err);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-2 text-[10px] font-mono text-[#cacac5]">
        <div className="flex items-center gap-2">
           <Monitor size={14} className="text-emerald-500 animate-pulse" />
           <span className="uppercase tracking-widest font-bold">Remote Terminal 01</span>
        </div>
        <div className="flex items-center gap-4">
           <span className="text-emerald-500/50">RES: 1280x720</span>
           <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" />
              LIVE
           </span>
        </div>
      </div>
      
      <div 
        ref={containerRef}
        onClick={handleClick}
        className="relative flex-1 bg-black rounded border border-[#b8b8b0]/20 overflow-hidden cursor-crosshair group shadow-inner"
      >
        {job.screenshot ? (
          <>
            <img 
              src={job.screenshot} 
              className="w-full h-full object-contain pointer-events-none"
              alt="Live Browser Feed"
            />
            {/* Scanline Overlay */}
            <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] opacity-10" />
            
            {/* Click Visualizer */}
            {clicked && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                 <div className="w-10 h-10 border-2 border-emerald-500 rounded-full animate-ping opacity-50" />
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-4 text-[#8a8a80]">
             <Loader2 size={32} className="animate-spin opacity-20" />
             <p className="font-mono text-[9px] uppercase tracking-[0.2em] animate-pulse">Initializing Video Stream...</p>
          </div>
        )}

        <div className="absolute bottom-2 right-2 px-2 py-1 bg-black/80 backdrop-blur rounded text-[8px] font-mono text-emerald-500/80 border border-emerald-500/20 pointer-events-none">
           CLICK ANYWHERE TO INTERACT
        </div>
      </div>
    </div>
  );
};

export function AutomationDownloader({
  projectId,
  projectRecord,
  scenes,
  config,
  onConnectDrive,
  onClose,
  onUpdateScenes,
  onMerge,
  mergeJobId,
  onMergeJobClear,
  onProjectPatch,
}: {
  projectId: string;
  projectRecord?: Project | null;
  scenes: any;
  config: any;
  onConnectDrive?: () => void;
  onClose?: () => void;
  onUpdateScenes?: (scenes: any) => void;
  onMerge?: (resolution: string, scenesForMerge?: any[]) => void;
  mergeJobId?: string | null;
  onMergeJobClear?: () => void;
  onProjectPatch?: (project: Project) => void;
}) {
  const [activeSubTab, setActiveSubTab] = useState<"queue" | "auth" | "logs" | "live" | "metrics">("queue");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [mergeStatus, setMergeStatus] = useState<any>(null);
  /** URL merge final của project hiện tại — chỉ set khi backend xác nhận project đã merge. */
  const [projectMergedUrl, setProjectMergedUrl] = useState<string | null>(null);
  const [mergeResolution, setMergeResolution] = useState<string>("1080p");
  const [mergeUploadBusy, setMergeUploadBusy] = useState(false);
  const [mergeUploadedDriveUrl, setMergeUploadedDriveUrl] = useState<string | null>(null);
  const [mergeUploadedDriveDirectUrl, setMergeUploadedDriveDirectUrl] = useState<string | null>(null);
  const [driveResyncBusy, setDriveResyncBusy] = useState(false);
  const [reuploadDriveBusy, setReuploadDriveBusy] = useState(false);
  
  // Load existing download data from localStorage
  useEffect(() => {
    async function loadExistingDownloads() {
       try {
          const cachedDownloadsStr = localStorage.getItem("local_video_downloads");
          if (cachedDownloadsStr) {
             const cachedDownloads = JSON.parse(cachedDownloadsStr);
             const existingJobs: Job[] = Object.keys(cachedDownloads).map((url) => ({
                id: url,
                stockUrl: url,
                stockTitle: "Previously Downloaded",
                status: "success",
                driveLink: cachedDownloads[url].driveLink,
             }));
             setJobs(existingJobs);
          }
       } catch (error) {
          console.error("Failed to load existing downloads", error);
       }
    }
    loadExistingDownloads();
  }, [projectId]);

  const hydrateProjectMerge = async (project: Project | null | undefined) => {
    if (!projectId || !project?.mergedVideoUrl) {
      setProjectMergedUrl(null);
      setMergeUploadedDriveUrl(null);
      setMergeUploadedDriveDirectUrl(null);
      return;
    }
    try {
      const head = await fetch(project.mergedVideoUrl, { method: "HEAD" });
      if (!head.ok) {
        setProjectMergedUrl(null);
        return;
      }
      setProjectMergedUrl(project.mergedVideoUrl);
      setMergeUploadedDriveUrl(project.mergeDriveViewUrl || null);
      setMergeUploadedDriveDirectUrl(project.mergeDriveDirectUrl || null);
    } catch {
      setProjectMergedUrl(null);
    }
  };

  useEffect(() => {
    setMergeStatus(null);
    setProjectMergedUrl(null);
    setMergeUploadedDriveUrl(null);
    setMergeUploadedDriveDirectUrl(null);
    void hydrateProjectMerge(projectRecord);
  }, [projectId, projectRecord?.mergedVideoUrl, projectRecord?.mergeDriveViewUrl, projectRecord?.mergeDriveDirectUrl]);

  useEffect(() => {
    if (!mergeJobId || !projectId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/merge-job/${mergeJobId}?t=${Date.now()}`,
          { cache: "no-store", headers: { "Cache-Control": "no-cache" } }
        );
        const data = await res.json();
        if (!stopped) {
          setMergeStatus(data);
          if (data.status === "success" && data.mergedVideoUrl) {
            setProjectMergedUrl(data.mergedVideoUrl);
            try {
              const updated = await updateProjectApi(projectId, {
                mergedVideoUrl: data.mergedVideoUrl,
                mergedAt: new Date().toISOString(),
                status: "completed",
              });
              onProjectPatch?.(updated);
            } catch (e) {
              console.warn("Could not save merge to project", e);
            }
          }
        }
        return data.status === "success" || data.status === "error";
      } catch {
        return false;
      }
    };
    poll();
    const interval = setInterval(async () => {
      if (await poll()) clearInterval(interval);
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [mergeJobId, projectId, onProjectPatch]);
  
  const [folderLink, setFolderLink] = useState<string>("");
  const [loadingDriveConfig, setLoadingDriveConfig] = useState(true);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [isStopping, setIsStopping] = useState(false);
  const [notifiError, setNotifiError] = useState<string>("");

  useEffect(() => {
    async function loadDriveConfig() {
       try {
          const localLink = localStorage.getItem("local_user_drive_link");
          if (localLink) {
             setFolderLink(localLink);
          }
       } catch (error) {
          console.error("Failed to load drive config", error);
       } finally {
          setLoadingDriveConfig(false);
       }
    }
    loadDriveConfig();
  }, []); // Only run once on mount

  const extractFolderId = (url: string) => {
    if (!url) return "";
    // Handle Google Drive folder URL formats
    const match = url.match(/folders\/([-\w]{25,})/) || url.match(/id=([-\w]{25,})/) || url.match(/([-\w]{25,})/);
    return match ? (match[1] || match[0]) : url;
  };

  useEffect(() => {
    const id = extractFolderId(folderLink);
    setSelectedFolderId(id);
  }, [folderLink]);

  const handleLinkChange = async (link: string) => {
     setFolderLink(link);
     try {
       localStorage.setItem("local_user_drive_link", link);
     } catch (err) {
       console.error("Failed to save folder link", err);
     }
  };

  const handleCancelMerge = async () => {
    if (!mergeJobId) return;
    try {
      await fetch(`/api/projects/${projectId}/merge-job/${mergeJobId}/cancel`, { method: "POST" });
    } catch (e) {
      console.error("Cancel merge failed", e);
    }
    onMergeJobClear?.();
    setMergeStatus(null);
  };

  const mergeInProgress =
    !!mergeJobId &&
    mergeStatus &&
    mergeStatus.status !== "success" &&
    mergeStatus.status !== "error";

  const mergeSucceeded = !!projectMergedUrl;

  const handleDownloadMergedLocal = () => {
    const base = mergedExportBasenameFromUrl(projectMergedUrl);
    if (!base) return;
    window.location.href = `/api/exports/merged-download/${encodeURIComponent(base)}`;
  };

  const handleUploadMergedToDrive = async () => {
    const base = mergedExportBasenameFromUrl(projectMergedUrl);
    if (!base) {
      setNotifiError("Không xác định được file merge.");
      return;
    }
    if (!config.driveAccessToken) {
      setNotifiError("Chưa kết nối Google Drive (tab Auth Cookies).");
      setActiveSubTab("auth");
      return;
    }
    if (!selectedFolderId) {
      setNotifiError("Thiếu link folder đích Drive.");
      setActiveSubTab("auth");
      return;
    }
    setMergeUploadBusy(true);
    try {
      const res = await fetch("/api/drive/upload-merged", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: base,
          driveToken: config.driveAccessToken,
          driveFolderId: selectedFolderId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
      }
      const viewLink =
        (data.webViewLink as string) ||
        (data.id ? `https://drive.google.com/file/d/${data.id}/view` : "");
      const directLink =
        (data.webContentLink as string) ||
        (data.id ? `https://drive.google.com/uc?export=download&id=${data.id}` : "");
      if (viewLink || directLink) {
        if (viewLink) setMergeUploadedDriveUrl(viewLink);
        if (directLink) setMergeUploadedDriveDirectUrl(directLink);
        if (projectId) {
          try {
            const updated = await updateProjectApi(projectId, {
              mergeDriveViewUrl: viewLink || null,
              mergeDriveDirectUrl: directLink || null,
            });
            onProjectPatch?.(updated);
          } catch (e) {
            console.warn("Could not save Drive links to project", e);
          }
        }
      } else setNotifiError("Upload xong nhưng không nhận được link Drive.");
    } catch (e: any) {
      setNotifiError(e?.message || "Upload Drive thất bại.");
    } finally {
      setMergeUploadBusy(false);
    }
  };

  const copyLogs = () => {
    const mergeLines =
      mergeJobId && mergeStatus?.logs?.length
        ? `\n\n[ MERGE JOB ${mergeJobId} ]\n${(mergeStatus.logs as string[]).join("\n")}`
        : "";
    const logs = jobs
      .filter(j => j.status !== "idle")
      .map(j => `[${new Date().toLocaleTimeString()}] INFO: Job ${j.id.substring(0, 8)} status changed to ${j.status.toUpperCase()}${j.error ? `\nERROR: ${j.error}` : ''}${j.driveLink ? `\nDRIVE: ${j.driveLink}` : ''}${j.driveDirectLink ? `\nDIRECT: ${j.driveDirectLink}` : ''}`)
      .join('\n');
    
    if (logs || mergeLines) {
      navigator.clipboard.writeText(`[ SYSTEM CONSOLE LOGS ]\n\n${logs}${mergeLines}`);
    }
  };

  // Collect selected videos from scenes
  const selectedVideos = useMemo(() => {
    const vids: any[] = [];
    if (!scenes) return vids;
    scenes.forEach((scene: any) => {
      const sVids = scene.selectedVideos && scene.selectedVideos.length > 0 
        ? scene.selectedVideos 
        : [{ videoIdx: scene.selectedVideoIdx || 0 }];
      
      sVids.forEach((sv: any) => {
        if (!scene.videos) return;
        const v = scene.videos[sv.videoIdx] || scene.videos[0];
        if (v && v.stockUrl) {
           if (!vids.find(x => x.id === v.url)) {
               vids.push({
                  id: v.url,
                  stockUrl: v.stockUrl,
                  title: v.title
               });
           }
        }
      });
    });
    return vids;
  }, [scenes]);

  /** Clip có id/link Drive để re-upload (ưu tiên Queue SUCCESS, bổ sung từ scenes / timeline). */
  const reuploadClipPayload = useMemo(
    () => buildReuploadClipsPayload(jobs, scenes, selectedVideos),
    [jobs, scenes, selectedVideos],
  );

  /** Merge final chỉ ghép file gốc trên Drive — mọi clip trong timeline phải có Drive ID / link. */
  const mergeDriveReady = useMemo(() => {
    if (!scenes?.length) return false;
    const seen = new Set<string>();
    const clipHasDrive = (v: {
      url?: string;
      stockUrl?: string;
      driveFileId?: string;
      driveLink?: string;
      driveDirectLink?: string;
    }) => {
      if (resolveDriveFileIdForVideo(v)) return true;
      const job = jobs.find(
        (j) =>
          j.status === "success" &&
          (j.id === v.url || j.stockUrl === v.stockUrl),
      );
      if (!job) return false;
      return !!resolveDriveFileIdForVideo({
        driveFileId: job.driveFileId,
        driveLink: job.driveLink,
        driveDirectLink: job.driveDirectLink,
      });
    };
    for (const scene of scenes) {
      const sVids =
        scene.selectedVideos && scene.selectedVideos.length > 0
          ? scene.selectedVideos
          : [{ videoIdx: scene.selectedVideoIdx ?? 0 }];
      for (const sv of sVids) {
        if (!scene.videos) continue;
        const v = scene.videos[sv.videoIdx] || scene.videos[0];
        if (!v?.stockUrl) continue;
        const key = (v.url || v.stockUrl) as string;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!clipHasDrive(v)) return false;
      }
    }
    return seen.size > 0;
  }, [scenes, jobs]);

  /** Phục hồi driveLink/driveFileId trên scenes từ queue (sau bug ghi đè hoặc reload). */
  useEffect(() => {
    if (!scenes?.length || !jobs.length || !onUpdateScenes) return;
    const newScenes = JSON.parse(JSON.stringify(scenes)) as typeof scenes;
    let changed = false;
    for (const job of jobs) {
      if (job.status !== "success") continue;
      const jobId = resolveDriveFileIdForVideo({
        driveFileId: job.driveFileId,
        driveLink: job.driveLink,
        driveDirectLink: job.driveDirectLink,
      });
      if (!jobId) continue;
      for (const scene of newScenes) {
        if (!scene.videos) continue;
        for (const v of scene.videos) {
          if (v.url !== job.id && v.stockUrl !== job.stockUrl) continue;
          const cur = resolveDriveFileIdForVideo(v);
          if (!cur || cur !== jobId) {
            v.driveLink = job.driveLink || v.driveLink;
            v.driveFileId = job.driveFileId || jobId;
            if (job.driveDirectLink) v.driveDirectLink = job.driveDirectLink;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      onUpdateScenes(newScenes);
    }
  }, [jobs, scenes, onUpdateScenes]);

  useEffect(() => {
    if (!projectId) return;
    const eventSource = new EventSource(`/api/downloader/events/${projectId}`);
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.jobs) {
           setJobs(prevJobs => {
              const incoming = data.jobs as Job[];
              // Phiên server mới thường gửi jobs: [] — không ghi đè cache local / jobs đã hydrate.
              if (incoming.length === 0 && prevJobs.length > 0) {
                return prevJobs;
              }

              const newScenes = JSON.parse(JSON.stringify(scenes));
              let scenesMutated = false;

              for (const newJob of incoming as Job[]) {
                if (newJob.status !== "success") continue;
                const oldJob = prevJobs.find((j) => j.id === newJob.id);
                const transitioned =
                  !oldJob || oldJob.status !== "success";
                const jobDriveId = resolveDriveFileIdForVideo({
                  driveFileId: newJob.driveFileId,
                  driveLink: newJob.driveLink,
                  driveDirectLink: newJob.driveDirectLink,
                });
                if (!jobDriveId) continue;

                for (const scene of newScenes) {
                  if (!scene.videos) continue;
                  for (const v of scene.videos) {
                    if (v.url !== newJob.id && v.stockUrl !== newJob.stockUrl) {
                      continue;
                    }
                    const cur = resolveDriveFileIdForVideo(v);
                    if (cur !== jobDriveId) {
                      v.driveLink = newJob.driveLink || v.driveLink;
                      v.driveFileId = newJob.driveFileId || jobDriveId;
                      if (newJob.driveDirectLink) {
                        v.driveDirectLink = newJob.driveDirectLink;
                      }
                      scenesMutated = true;
                    }
                  }
                }

                if (transitioned) {
                  try {
                    const localCache = JSON.parse(
                      localStorage.getItem("local_video_downloads") || "{}",
                    );
                    localCache[newJob.stockUrl || newJob.id] = {
                      driveLink: newJob.driveLink,
                      createdAt: new Date().toISOString(),
                    };
                    localStorage.setItem(
                      "local_video_downloads",
                      JSON.stringify(localCache),
                    );
                  } catch (e) {
                    console.error(e);
                  }
                  console.log(
                    `Job ${newJob.id} succeeded. Updated scenes with Drive info (batched).`,
                  );
                }
              }

              if (scenesMutated && onUpdateScenes) {
                setTimeout(() => onUpdateScenes(newScenes), 0);
              }

              const hadError = prevJobs.some((j: Job) => j.status === "error");
              const hasErrorNow = incoming.filter(
                (j: Job) => j.status === "error" && j.error,
              );
              if (!hadError && hasErrorNow.length > 0) {
                 const rootError = hasErrorNow.find((j: Job) => j.error && !j.error.includes("AUTO_STOP")) || hasErrorNow[0];
                 setNotifiError(`Hệ thống tự động dừng: ${rootError.error}`);
              }
              return incoming;
           });
        }
      } catch (e) {}
    };
    return () => eventSource.close();
  }, [projectId, scenes, onUpdateScenes]);

  const startDownload = async (videosToDownload: any[]) => {
     if (!config.storyblocksCookies && videosToDownload.length > 0) {
        setNotifiError("Thiếu cấu hình Session Cookies. Vui lòng thêm trong thẻ Auth Cookies.");
        setActiveSubTab("auth");
        return;
     }

     if (!config.driveAccessToken) {
        setNotifiError("Chưa kết nối Google Drive. Vui lòng kết nối trong thẻ Auth Cookies.");
        setActiveSubTab("auth");
        return;
     }

     if (!selectedFolderId) {
        setNotifiError("Oops, thiếu Link đích đến Google Drive folder. Vui lòng nhập link trong thẻ Auth Cookies.");
        setActiveSubTab("auth");
        return;
     }

     setNotifiError(""); // Clear any previous error
     
     try {
       const res = await fetch("/api/downloader/start", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({
           projectId,
           videos: videosToDownload,
           cookies: config.storyblocksCookies,
           driveToken: config.driveAccessToken,
           driveFolderId: selectedFolderId
         }),
       });
       const data = await res.json().catch(() => ({}));
       if (res.status === 409 && typeof (data as { error?: string }).error === "string") {
         setNotifiError((data as { error: string }).error);
         return;
       }
     } catch (e: any) {
       console.error(e);
       setNotifiError(`Lỗi kết nối server: ${e.message}`);
     }
  };

  const handleStopAutomation = async () => {
    setIsStopping(true);
    try {
      await fetch("/api/downloader/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
    } catch (e) {
      console.error("Stop failed", e);
    } finally {
      setTimeout(() => setIsStopping(false), 2000);
    }
  };

  const startAll = () => startDownload(selectedVideos);
  const retryJob = (jobId: string) => {
     const v = selectedVideos.find(x => x.id === jobId);
     if (v) startDownload([v]);
  };

  const handleBulkReuploadToTargetFolder = async () => {
    if (!projectId) {
      toast.error("Thiếu project.");
      return;
    }
    if (!selectedFolderId) {
      setNotifiError("Cần Target destination folder link (tab Auth Cookies).");
      setActiveSubTab("auth");
      return;
    }
    if (reuploadClipPayload.length === 0) {
      toast.error(
        "Không có clip nào có link Direct / id Google Drive hợp lệ (timeline hoặc Queue).",
      );
      return;
    }
    if (mergeInProgress || reuploadDriveBusy) return;

    const ok = window.confirm(
      `Upload lại ${reuploadClipPayload.length} clip vào folder đích?\n\n` +
        `Hệ thống sẽ: tải qua link Direct (HTTP) → upload file mới vào folder đích; clip đã nằm sẵn trong folder đích thì bỏ qua (tránh trùng).\n` +
        `Sau khi xong, link & Direct trên Queue cập nhật theo file mới.`,
    );
    if (!ok) return;

    setReuploadDriveBusy(true);
    setNotifiError("");
    try {
      const res = await fetch("/api/downloader/reupload-drive-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          driveToken: config.driveAccessToken || undefined,
          driveFolderId: selectedFolderId,
          clips: reuploadClipPayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          typeof data.error === "string"
            ? data.error
            : `HTTP ${res.status}`;
        setNotifiError(msg);
        toast.error(msg);
        return;
      }
      const n = typeof data.count === "number" ? data.count : reuploadClipPayload.length;
      if (n === 0) {
        toast(
          typeof data.message === "string"
            ? data.message
            : "Không có clip nào cần upload (có thể đã có trong folder đích).",
          { icon: "ℹ️", duration: 6000 },
        );
        return;
      }
      toast.success(
        `Đã bắt đầu upload lại ${n} clip (tải Direct HTTP). Xem Queue; xong rồi lưu project và thử Merge.`,
        { duration: 6000 },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Lỗi mạng.";
      setNotifiError(msg);
      toast.error(msg);
    } finally {
      setReuploadDriveBusy(false);
    }
  };

  const handleResyncDriveFromCache = async () => {
    if (!scenes?.length) {
      toast.error("Không có phân cảnh để đồng bộ.");
      return;
    }
    setDriveResyncBusy(true);
    try {
      const res = await fetch("/api/drive/resync-scene-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenes }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotifiError(
          typeof data.error === "string"
            ? data.error
            : "Đồng bộ Drive cache thất bại.",
        );
        return;
      }
      const n = typeof data.refreshedCount === "number" ? data.refreshedCount : 0;
      if (data.scenes && onUpdateScenes) {
        onUpdateScenes(data.scenes);
      }
      if (n > 0) {
        toast.success(
          `Đã cập nhật ${n} clip từ Firestore (videoDownloads). Lưu project rồi thử Merge lại.`,
        );
      } else {
        toast(
          "Không có bản ghi videoDownloads khớp stockUrl. Chạy Auto lại cho clip thiếu hoặc kiểm tra Firestore.",
          { icon: "ℹ️", duration: 5000 },
        );
      }
    } catch (e: unknown) {
      setNotifiError(
        e instanceof Error ? e.message : "Lỗi mạng khi đồng bộ Drive.",
      );
    } finally {
      setDriveResyncBusy(false);
    }
  };

  const handleMergeFinalClick = () => {
    const payload = buildScenesForMergeFromQueue(scenes, jobs);
    onUpdateScenes?.(payload);
    onMerge?.(mergeResolution, payload);
  };

  const metrics = useMemo(() => {
    const total = jobs.length;
    const success = jobs.filter(j => j.status === "success").length;
    const error = jobs.filter(j => j.status === "error").length;
    const progress = total > 0 ? (success / total) * 100 : 0;
    const dataVolumeBytes = jobs
      .filter((j) => j.status === "success")
      .reduce((sum, j) => sum + (typeof j.fileSizeBytes === "number" && j.fileSizeBytes > 0 ? j.fileSizeBytes : 0), 0);
    return { total, success, error, progress, dataVolumeBytes };
  }, [jobs]);

  return (
    <div className="flex-1 flex flex-col bg-[#d8d8d4] text-[#1a1a1a] font-mono overflow-hidden relative">
       {mergeStatus && mergeStatus.status === 'error' && (
          <div className="bg-red-600 text-white px-4 py-2 text-[10px] font-bold uppercase flex items-center gap-2">
             <XCircle size={12} /> Merge thất bại: {mergeStatus.error === 'MERGE_CANCELLED' ? 'Đã hủy bởi user' : (mergeStatus.current || mergeStatus.error)}
             {mergeStatus.logs?.length > 0 && (
               <button type="button" onClick={() => setActiveSubTab('logs')} className="ml-auto underline text-[9px] normal-case">Xem Console</button>
             )}
          </div>
       )}
       {mergeStatus && mergeStatus.status !== 'success' && mergeStatus.status !== 'error' && (
          <div className="bg-indigo-700 text-white px-4 py-2 text-[10px] font-bold uppercase flex items-center gap-3">
             <Loader2 size={12} className="animate-spin shrink-0" />
             <div className="flex-1 min-w-0">
               <div className="flex items-center justify-between mb-1 gap-2">
                 <span className="truncate normal-case font-mono text-[9px]">{mergeStatus.phase ? `[${mergeStatus.phase}] ` : ''}{mergeStatus.current || `Rendering: ${mergeStatus.progress ?? 0}%`}</span>
                 <span className="ml-2 shrink-0">{mergeStatus.progress ?? 0}%</span>
               </div>
               <div className="h-1 bg-indigo-900 rounded overflow-hidden w-full">
                 <div className="h-full bg-white transition-all duration-500 rounded" style={{ width: `${mergeStatus.progress ?? 0}%` }} />
               </div>
             </div>
             <button
               type="button"
               onClick={handleCancelMerge}
               className="shrink-0 px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-[9px] font-bold uppercase"
             >
               Hủy merge
             </button>
          </div>
       )}
       {mergeSucceeded && projectMergedUrl && (
          <MergedProjectOutput
            variant="banner"
            mergedVideoUrl={projectMergedUrl}
            mergeUploadBusy={mergeUploadBusy}
            canUploadDrive={!!(config.driveAccessToken && selectedFolderId)}
            mergeUploadedDriveUrl={mergeUploadedDriveUrl}
            mergeUploadedDriveDirectUrl={mergeUploadedDriveDirectUrl}
            onDownload={handleDownloadMergedLocal}
            onUploadDrive={handleUploadMergedToDrive}
          />
       )}
      <AnimatePresence>
         {notifiError && (
           <motion.div 
             initial={{ opacity: 0, y: 50, scale: 0.9 }} 
             animate={{ opacity: 1, y: 0, scale: 1 }} 
             exit={{ opacity: 0, scale: 0.9, y: 20 }} 
             className="absolute bottom-6 right-[320px] z-50 bg-red-600 text-white p-4 rounded shadow-2xl flex items-start gap-4 max-w-md border border-red-800"
           >
              <XCircle size={18} className="mt-0.5 shrink-0" />
              <div>
                 <h4 className="font-bold text-sm uppercase tracking-widest mb-1">Cảnh báo hệ thống</h4>
                 <p className="text-xs text-red-100">{notifiError}</p>
                 <button onClick={() => setNotifiError("")} className="mt-3 text-[10px] font-bold uppercase underline hover:text-white">Đã hiểu</button>
              </div>
           </motion.div>
         )}
      </AnimatePresence>
      
      {/* Top Status Bar */}
      <div className="min-h-10 border-b border-[#b8b8b0] flex flex-wrap items-center justify-between gap-y-2 gap-x-4 px-6 py-1.5 bg-[#cacac5] text-[10px] font-bold uppercase tracking-widest text-[#4a4a40]">
        <div className="flex items-center gap-4">
          <button 
            onClick={onClose}
            className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#b8b8b0] rounded transition-colors border border-transparent hover:border-[#a8a8a0] text-[#1a1a1a]"
          >
             <ArrowLeft size={14} /> <span>Back to Studio</span>
          </button>
          <div className="w-px h-4 bg-[#b8b8b0]"></div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
            SYSTEM STANDBY
          </div>
          <div className="w-px h-4 bg-[#b8b8b0]"></div>
          <div>Project ID: <span className="text-[#1a1a1a]">{projectId ? projectId.substring(0, 8) : "N/A"}...</span></div>
        </div>
        <div className="flex flex-wrap items-center gap-2 justify-end shrink-0 max-w-full">
            {scenes?.length > 0 && (
              <button
                type="button"
                onClick={() => void handleResyncDriveFromCache()}
                disabled={mergeInProgress || driveResyncBusy}
                title="Lấy lại link / file ID Google Drive từ Firestore (videoDownloads, theo stockUrl). Không upload lại — dùng khi merge báo 404."
                className="text-[10px] font-bold uppercase tracking-wide px-3 py-1 rounded border border-amber-700/40 bg-amber-200/90 text-amber-950 hover:bg-amber-300 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {driveResyncBusy ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                Đồng bộ Drive cache
              </button>
            )}
            {reuploadClipPayload.length > 0 && (
              <button
                type="button"
                onClick={() => void handleBulkReuploadToTargetFolder()}
                disabled={
                  mergeInProgress ||
                  reuploadDriveBusy ||
                  !selectedFolderId ||
                  jobs.some(
                    (j) => j.status === "downloading" || j.status === "uploading",
                  )
                }
                title={
                  !selectedFolderId
                    ? "Cần link folder đích (Auth Cookies)."
                    : "Tải qua link Direct (HTTP), upload vào folder đích; bỏ qua clip đã có trong folder."
                }
                className="text-[10px] font-bold uppercase tracking-wide px-3 py-1 rounded border border-emerald-800/40 bg-emerald-200/90 text-emerald-950 hover:bg-emerald-300 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {reuploadDriveBusy ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Upload size={12} />
                )}
                Upload lại folder đích ({reuploadClipPayload.length})
              </button>
            )}
            {metrics.progress === 100 && metrics.total > 0 ? (
              <>
                <select
                  value={mergeResolution}
                  onChange={(e) => setMergeResolution(e.target.value)}
                  className="text-[10px] font-mono font-bold uppercase bg-[#d8d8d4] border border-[#b8b8b0] rounded px-2 py-1 text-[#1a1a1a]"
                  title="Độ phân giải output merge (file nguồn: Google Drive HD)"
                >
                  <option value="1080p">1080p (1920×1080)</option>
                  <option value="720p">720p (1280×720)</option>
                  <option value="480p">480p (854×480)</option>
                </select>
                <button 
                  onClick={handleMergeFinalClick}
                  disabled={!mergeDriveReady || mergeInProgress}
                  title={
                    !mergeDriveReady
                      ? "Merge chỉ dùng bản gốc trên Drive. Cần mọi clip trong timeline có link/id Drive (ưu tiên dữ liệu Queue SUCCESS)."
                      : mergeSucceeded
                        ? "Ghép lại video final từ các clip trên Drive (payload lấy từ Queue + Studio)"
                        : "Ghép video từ file đã upload Drive — không cần nhập lại thư mục đích nếu Queue đã SUCCESS"
                  }
                  className="bg-indigo-600 text-white px-4 py-1 rounded hover:bg-indigo-700 transition-colors flex items-center gap-2 font-bold shadow-[0_0_15px_rgba(79,70,229,0.4)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <MonitorPlay size={12} /> {mergeSucceeded ? "Merge lại" : "Merge Final Video"}
                </button>
              </>
            ) : null}
            {jobs.some(j => j.status === "downloading" || j.status === "uploading") && (
              <button 
                onClick={handleStopAutomation}
                disabled={isStopping}
                className="bg-red-600 text-white px-4 py-1 rounded hover:bg-red-700 transition-colors flex items-center gap-2 font-bold"
              >
                {isStopping ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />} 
                Stop System
              </button>
            )}
            <button 
              onClick={startAll}
              disabled={jobs.some(j => j.status === "downloading" || j.status === "uploading")}
              className={`px-4 py-1 rounded transition-colors flex items-center gap-2 font-bold ${
                jobs.some(j => j.status === "downloading" || j.status === "uploading")
                ? "bg-[#b8b8b0] text-[#6a6a60]"
                : "bg-[#1a1a1a] text-white hover:bg-[#333]"
              }`}
            >
              <Zap size={12} fill="currentColor" /> Start Automation
            </button>
          </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content Area */}
        <div className="flex-1 flex flex-col border-r border-[#b8b8b0]">
          {/* Navigation Tabs */}
          <div className="h-12 border-b border-[#b8b8b0] flex bg-[#cacac5]">
            {[
              { id: "queue", label: "Queue", icon: ListIcon },
              { id: "live", label: "Live Control", icon: Monitor },
              { id: "auth", label: "Auth Cookies", icon: Key },
              { id: "metrics", label: "Analytics", icon: BarChart3 },
              { id: "logs", label: "Console", icon: Terminal }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveSubTab(tab.id as any)}
                className={`px-6 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest transition-all border-r border-[#b8b8b0] ${
                  activeSubTab === tab.id 
                    ? "bg-[#d8d8d4] text-[#1a1a1a]" 
                    : "text-[#6a6a60] hover:text-[#1a1a1a] hover:bg-[#c0c0ba]"
                }`}
              >
                <tab.icon size={12} /> {tab.label}
              </button>
            ))}
          </div>

          {/* Sub-tab Content */}
          <div className="flex-1 overflow-y-auto p-6 custom-scrollbar text-[#1a1a1a]">
            {activeSubTab === "queue" && (
              <div className="space-y-1">
                {mergeSucceeded && projectMergedUrl && (
                  <MergedProjectOutput
                    variant="panel"
                    mergedVideoUrl={projectMergedUrl}
                    mergeUploadBusy={mergeUploadBusy}
                    canUploadDrive={!!(config.driveAccessToken && selectedFolderId)}
                    mergeUploadedDriveUrl={mergeUploadedDriveUrl}
                    mergeUploadedDriveDirectUrl={mergeUploadedDriveDirectUrl}
                    onDownload={handleDownloadMergedLocal}
                    onUploadDrive={handleUploadMergedToDrive}
                  />
                )}
                <div className="grid grid-cols-12 gap-4 text-[10px] font-bold text-[#6a6a60] uppercase tracking-tighter pb-2 border-b border-[#b8b8b0] mb-4">
                  <div className="col-span-6">Source Entity</div>
                  <div className="col-span-2">Time</div>
                  <div className="col-span-2">Method</div>
                  <div className="col-span-2 text-right">Status / Action</div>
                </div>
                
                {selectedVideos.map((v, idx) => {
                  const job = jobs.find(j => j.id === v.id);
                  return (
                    <motion.div 
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      key={v.id} 
                      className="grid grid-cols-12 gap-4 items-center py-2 border-b border-[#c8c8c0] hover:bg-[#e0e0da] transition-colors group"
                    >
                      <div className="col-span-6 flex items-center gap-3 min-w-0">
                        <div className="w-12 h-7 bg-black rounded shrink-0 overflow-hidden relative">
                           <video src={v.id} className="w-full h-full object-cover" muted />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-bold truncate">{v.title}</p>
                          <p className="text-[9px] text-[#6a6a60] truncate">{v.stockUrl}</p>
                        </div>
                      </div>
                      <div className="col-span-2 text-[10px] font-mono text-[#4a4a40] flex flex-col">
                        {job?.downloadDuration && <span title="Download Time">DL: {job.downloadDuration}s</span>}
                        {job?.uploadDuration && <span title="Upload Time">UP: {job.uploadDuration}s</span>}
                        {!job?.downloadDuration && !job?.uploadDuration && "00:00:15"}
                      </div>
                      <div className="col-span-2 text-[10px] font-bold text-[#6a6a60]">PUPPETEER</div>
                      <div className="col-span-2 flex justify-end items-center gap-3">
                         {job?.status === "downloading" && <span className="text-[9px] font-bold text-blue-600 animate-pulse">DOWNLOADING</span>}
                         {job?.status === "uploading" && <span className="text-[9px] font-bold text-amber-600 animate-pulse">UPLOADING</span>}
                         {job?.status === "success" && (
                            <motion.div layout className="flex flex-col items-end gap-1">
                              <span className="text-[9px] font-bold text-emerald-600">SUCCESS</span>
                              {(job.driveLink || job.driveFileId) && (
                                <DriveLinkActions
                                  viewLink={job.driveLink}
                                  directLink={resolveDriveDirectLink(job)}
                                />
                              )}
                            </motion.div>
                         )}
                         {job?.status === "error" && <span className="text-[9px] font-bold text-red-600" title={job.error}>FAILED</span>}
                         {!job && <span className="text-[9px] font-bold text-[#8a8a80]">IDLE</span>}
                         
                         {(job?.status === "error" || job?.status === "success" || !job) && (
                           <button onClick={() => retryJob(v.id)} className="p-1 hover:bg-[#1a1a1a] hover:text-white rounded transition-colors">
                             <Play size={10} fill="currentColor" />
                           </button>
                         )}
                      </div>
                    </motion.div>
                  )
                })}
                {selectedVideos.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-20 opacity-20">
                     <DownloadCloud size={40} />
                     <p className="text-[10px] mt-2 font-bold uppercase tracking-widest">No target data detected in queue</p>
                  </div>
                )}
              </div>
            )}

            {activeSubTab === "auth" && (
              <div className="max-w-2xl space-y-8">
                 <div>
                    <h3 className="text-sm font-bold uppercase border-b border-[#1a1a1a] pb-1 mb-4 flex items-center gap-2">
                       <ShieldCheck size={16} /> Authentication Context
                    </h3>
                    <p className="text-[11px] text-[#4a4a40] mb-6 leading-relaxed">
                       Hệ thống yêu cầu Storyblocks Session Cookies để thực hiện tải xuống bản không có watermark. Khi bạn dán Cookies vào đây, Puppeteer sẽ sử dụng chúng để giả lập phiên đăng nhập của bạn.
                    </p>
                    
                    <div className="bg-[#cacac5] p-6 border border-[#b8b8b0] rounded-lg space-y-4 shadow-inner">
                       <label className="text-[10px] font-bold uppercase tracking-widest block text-[#4a4a40]">Session Cookies (Raw String)</label>
                       <textarea 
                          className="w-full bg-[#d8d8d4] border border-[#b8b8b0] p-4 text-[10px] font-mono outline-none focus:border-[#1a1a1a] transition-all min-h-[150px] resize-none"
                          placeholder="Paste cookie string from browser devtools..."
                          value={config.storyblocksCookies || ""}
                          readOnly
                       />
                       <p className="text-[9px] text-[#6a6a60] italic">Cookies are managed in Project Settings. Go back to Studio to update.</p>
                    </div>
                 </div>

                 <div>
                    <h3 className="text-sm font-bold uppercase border-b border-[#1a1a1a] pb-1 mb-4 flex items-center gap-2">
                       <HardDrive size={16} /> Cloud Storage Provider
                    </h3>
                    <div className="bg-[#cacac5] p-6 border border-[#b8b8b0] rounded-lg space-y-6 shadow-inner">
                       <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4">
                             <div className={`p-3 rounded-full ${config.driveAccessToken ? "bg-emerald-500/10 text-emerald-600" : "bg-[#b8b8b0] text-[#6a6a60]"}`}>
                                <HardDrive size={24} />
                             </div>
                             <div>
                                <h4 className="text-xs font-bold uppercase">Google Drive API</h4>
                                <p className="text-[10px] text-[#6a6a60]">{config.driveAccessToken ? "Connection established and ready" : "Awaiting user authorization"}</p>
                             </div>
                          </div>
                          <button 
                            onClick={onConnectDrive}
                            className="bg-[#1a1a1a] text-white text-[10px] font-bold uppercase tracking-wider px-4 py-2 hover:bg-[#333] transition-colors"
                          >
                             {config.driveAccessToken ? "Re-sync Drive" : "Connect Provider"}
                          </button>
                       </div>

                       {config.driveAccessToken && (
                         <div className="space-y-2 border-t border-[#b8b8b0] pt-4">
                            <label className="text-[10px] font-bold uppercase tracking-widest block text-[#4a4a40]">Target Destination Folder Link</label>
                            <div className="flex gap-2">
                               <input 
                                 type="text"
                                 placeholder="Paste Google Drive folder URL here..."
                                 value={folderLink}
                                 onChange={(e) => handleLinkChange(e.target.value)}
                                 className="flex-1 bg-[#d8d8d4] border border-[#b8b8b0] px-3 py-2 text-xs font-mono outline-none focus:border-[#1a1a1a] transition-all"
                               />
                            </div>
                            <p className="text-[9px] text-[#6a6a60] italic">
                              Bắt buộc khi bấm <strong>Start Automation</strong> (upload clip mới).{" "}
                              <strong>Merge Final Video</strong> dùng link từng file đã SUCCESS trên Queue
                              — không cần giữ ô này để merge.
                            </p>
                         </div>
                       )}
                    </div>
                 </div>
              </div>
            )}

            {activeSubTab === "metrics" && (
               <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                  {[
                    { label: "Items Total", value: metrics.total, icon: ListIcon },
                    { label: "Success Rate", value: `${metrics.progress.toFixed(1)}%`, icon: BarChart3 },
                    { label: "Failures", value: metrics.error, icon: XCircle },
                    { label: "Uptime", value: "99.9%", icon: Activity }
                  ].map(m => (
                    <div key={m.label} className="bg-[#cacac5] p-6 border border-[#b8b8b0] rounded-lg shadow-inner">
                       <m.icon size={20} className="mb-4 text-[#4a4a40]" />
                       <div className="text-[10px] font-bold text-[#6a6a60] uppercase mb-1">{m.label}</div>
                       <div className="text-2xl font-bold">{m.value}</div>
                    </div>
                  ))}
               </div>
            )}

            {activeSubTab === "live" && (
              <div className="h-full bg-[#1a1a1a] p-4 rounded overflow-hidden">
                {jobs.find(j => j.status === "downloading") ? (
                   <LiveBrowser job={jobs.find(j => j.status === "downloading")!} projectId={projectId} />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full gap-4 text-[#8a8a80]">
                    <ShieldCheck size={48} className="opacity-10" />
                    <div className="text-center space-y-1">
                      <p className="font-mono text-[10px] uppercase tracking-widest">Awaiting Active Socket</p>
                      <p className="text-[9px] opacity-50 px-8">The video stream initializes automatically when a download job becomes active.</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeSubTab === "logs" && (
              <div className="flex flex-col h-full gap-2">
                <div className="flex justify-end">
                   <button 
                     onClick={copyLogs}
                     className="flex items-center gap-1.5 px-3 py-1 bg-[#cacac5] hover:bg-[#b8b8b0] text-[9px] font-bold uppercase tracking-widest border border-[#b8b8b0] rounded transition-colors"
                   >
                      <Copy size={12} /> Copy All Logs
                   </button>
                </div>
                <div className="bg-[#1a1a1a] p-4 rounded flex-1 font-mono text-emerald-500 text-[10px] overflow-y-auto select-text selection:bg-emerald-500 selection:text-black">
                   <p className="opacity-50 border-b border-emerald-500/20 pb-1 mb-2 tracking-widest">[ SYSTEM CONSOLE INITIALIZED ]</p>
                   {mergeJobId && (mergeStatus?.logs?.length > 0 || mergeStatus?.error) && (
                      <div key="merge-logs" className="mb-3 border-l border-amber-500/40 pl-3">
                         <div className="flex items-center gap-2 mb-1">
                            <span className="opacity-40">[{new Date().toLocaleTimeString()}]</span>
                            <span className="text-amber-400 font-bold">MERGE:</span>
                            <span className="text-amber-200 font-mono text-[9px]">{mergeJobId}</span>
                         </div>
                         {mergeStatus?.error && (
                           <div className="ml-2 text-red-400 text-[9px] mb-1">{mergeStatus.error === 'MERGE_CANCELLED' ? 'Đã hủy' : mergeStatus.error}</div>
                         )}
                         <div className="ml-2 max-h-40 overflow-y-auto text-[9px] text-cyan-300/90 whitespace-pre-wrap font-mono leading-relaxed bg-black/30 p-2 rounded">
                           {(mergeStatus?.logs as string[])?.join('\n') || ''}
                         </div>
                      </div>
                   )}
                   {jobs.map(j => {
                      if (j.status === "idle") return null;
                      const isAutoStop = j.error === "AUTO_STOP: Preceding job failed";
                      return (
                        <div key={`log-${j.id}`} className="mb-2 border-l border-emerald-500/10 pl-3">
                           <div className="flex items-center gap-2">
                              <span className="opacity-40">[{new Date().toLocaleTimeString()}]</span> 
                              <span className={`${j.status === 'error' ? 'text-red-400' : 'text-blue-400'} font-bold`}>{j.status === 'error' ? 'FAIL:' : 'INFO:'}</span> 
                              Job <span className="text-amber-400">{j.id.substring(0, 8)}</span>: <span className="uppercase font-bold underline">{j.status}</span>
                           </div>
                           {j.error && (
                             <div className={`ml-4 text-[9px] mt-0.5 ${isAutoStop ? 'text-amber-500/80 italic' : 'text-red-400 bg-red-400/10 p-1.5 rounded border border-red-400/20 mt-1'}`}>
                                {isAutoStop ? "⚠️ SYSTEM AUTO-STOP: Job halted due to upstream failure" : `ROOT CAUSE: ${j.error}`}
                             </div>
                           )}
                           {j.driveLink && <div className="ml-4 text-emerald-400 font-bold bg-emerald-400/5 p-1 rounded mt-1">SYNC: {j.driveLink}</div>}
                           {j.driveDirectLink && <div className="ml-4 text-indigo-300 font-bold bg-indigo-400/5 p-1 rounded mt-1">DIRECT: {j.driveDirectLink}</div>}
                           {j.diagnostic && j.status !== 'error' && <div className="ml-4 text-[9px] text-blue-300 opacity-60 italic">→ {j.diagnostic}</div>}
                        </div>
                      )
                   })}
                   <div className="animate-pulse">_</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Sidebar - Analytics & Info */}
        <div className="w-[300px] bg-[#cacac5] border-l border-[#b8b8b0] p-6 flex flex-col gap-8 overflow-y-auto custom-scrollbar">
          <div>
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#6a6a60] mb-4 pb-1 border-b border-[#b8b8b0]">Project Context</h3>
            <div className="space-y-4">
               <div>
                  <div className="text-[9px] uppercase text-[#8a8a80]">Internal Identity</div>
                  <div className="text-xs font-bold truncate" title={projectId}>{projectId || "N/A"}</div>
               </div>
               <div>
                  <div className="text-[9px] uppercase text-[#8a8a80]">Active Configuration</div>
                  <div className="text-xs font-bold text-emerald-600 flex items-center gap-1"><ShieldCheck size={10} /> Verified Session</div>
               </div>
            </div>
          </div>

          <div>
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#6a6a60] mb-4 pb-1 border-b border-[#b8b8b0]">Diagnostic Capture</h3>
            <div className="bg-[#1a1a1a] aspect-video rounded-lg flex flex-col items-center justify-center border border-[#b8b8b0]/20 relative overflow-hidden group">
               {/* Scanline effect */}
               <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] z-10 opacity-30"></div>
               
               {jobs.find(j => j.status === "downloading" || j.status === "uploading") ? (
                 <div className="w-full h-full flex flex-col p-4 font-mono z-0">
                    <div className="flex items-center justify-between mb-auto text-[8px] text-emerald-500/50">
                       <span>PUPPETEER_INSTANCE_01</span>
                       <span className="animate-pulse">REC ●</span>
                    </div>
                    
                    <div className="flex-1 flex flex-col items-center justify-center gap-3">
                       <Monitor size={32} className="text-emerald-500 animate-pulse" />
                       <div className="text-center space-y-1">
                          <p className="text-[10px] text-emerald-400 font-bold uppercase tracking-widest select-text">
                             {jobs.find(j => j.status === "downloading") ? "ESTABLISHING HANDSHAKE" : "BYPASSING CLOUDFLARE"}
                          </p>
                          <p className="text-[9px] text-emerald-500/70 truncate max-w-[200px] select-text">
                             {jobs.find(j => j.status === "downloading" || j.status === "uploading")?.diagnostic || "AWAITING DOM_READY..."}
                          </p>
                       </div>
                    </div>

                    <div className="mt-auto flex gap-1 h-0.5 w-full bg-emerald-950 overflow-hidden">
                       <motion.div 
                         initial={{ x: "-100%" }}
                         animate={{ x: "100%" }}
                         transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                         className="h-full w-1/3 bg-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.5)]"
                       />
                    </div>
                 </div>
               ) : (
                 <div className="flex flex-col items-center gap-2 opacity-30">
                    <ShieldCheck size={24} className="text-[#cacac5]" />
                    <span className="text-[9px] font-bold uppercase tracking-tighter">No Active Capture</span>
                 </div>
               )}
            </div>
            <p className="text-[8px] text-[#8a8a80] mt-2 italic font-mono">Live stream simulated via session event metadata.</p>
          </div>

          <div>
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#6a6a60] mb-4 pb-1 border-b border-[#b8b8b0]">Performance Metrics</h3>
            <div className="space-y-6">
               <div className="flex flex-col gap-1 text-center">
                  <div className="text-[9px] uppercase text-[#8a8a80]">Aggregate Efficiency</div>
                  <div className="text-4xl font-bold tracking-tighter">{metrics.progress.toFixed(0)}%</div>
               </div>
               <div className="grid grid-cols-2 gap-2">
                  <div className="bg-[#d8d8d4] p-3 border border-[#b8b8b0] rounded">
                     <div className="text-[8px] uppercase text-[#8a8a80] mb-1">Items Processed</div>
                     <div className="text-lg font-bold">{metrics.success}</div>
                  </div>
                  <div className="bg-[#d8d8d4] p-3 border border-[#b8b8b0] rounded">
                     <div className="text-[8px] uppercase text-[#8a8a80] mb-1">Data Volume</div>
                     <div
                       className="text-lg font-bold text-indigo-600"
                       title="Tổng dung lượng file đã tải xong và upload Google Drive thành công (theo kích thước thực trên đĩa)"
                     >
                        {(() => {
                          const b = metrics.dataVolumeBytes;
                          if (b <= 0) return metrics.success > 0 ? "—" : "0 MB";
                          if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
                          if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
                          return `${Math.round(b / 1024)} KB`;
                        })()}
                     </div>
                  </div>
               </div>
            </div>
          </div>

          <div className="mt-auto">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#6a6a60] mb-4 pb-1 border-b border-[#b8b8b0]">Cloud Sync: Google Drive</h3>
            <div className={`p-4 border rounded-lg flex items-center justify-between ${config.driveAccessToken ? "bg-emerald-500/5 border-emerald-500/20" : "bg-red-500/5 border-red-500/20"}`}>
               <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${config.driveAccessToken ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`}></div>
                  <div className="text-[9px] font-bold uppercase">{config.driveAccessToken ? "Connected" : "Disconnected"}</div>
               </div>
               {!config.driveAccessToken && (
                 <button onClick={onConnectDrive} className="text-[9px] font-bold uppercase text-white bg-[#1a1a1a] px-2 py-1 rounded">Connect</button>
               )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
