export type ProjectStatus = "editing" | "completed";

export interface Project {
  id: string;
  title: string;
  userId: string;
  script: string;
  scenes: string;
  visualKeywordDirection?: string;
  pacingProfileJson?: string;
  audioUrl?: string | null;
  downloadUrl?: string | null;
  mergedVideoUrl?: string | null;
  mergedAt?: string | null;
  mergeDriveViewUrl?: string | null;
  mergeDriveDirectUrl?: string | null;
  /** `editing` = đang làm; `completed` = merge final video thành công */
  status?: ProjectStatus;
  /** JSON ProjectTokenUsageLog — lịch sử token theo bước. */
  tokenUsageJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function resolveProjectStatus(project: {
  status?: ProjectStatus | string | null;
  mergedVideoUrl?: string | null;
  mergedAt?: string | null;
}): ProjectStatus {
  if (project.status === "completed" || project.status === "editing") {
    return project.status;
  }
  return project.mergedVideoUrl ? "completed" : "editing";
}

export function formatProjectCreatedAtVi(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function projectStatusLabelVi(status: ProjectStatus): string {
  return status === "completed" ? "Hoàn thành" : "Đang chỉnh sửa";
}

export interface UserAppConfig {
  transcriptionModel: string;
  analysisModel: string;
  exportResolution: string;
  geminiApiKey: string;
  storyblocksProxies: string;
  storyblocksCookies: string;
  driveAccessToken: string;
  tokenUsdToVnd?: number;
  tokenModelPricingJson?: string;
  tokenStorePromptDetails?: boolean;
}

/** Legacy localStorage key — chỉ dùng khi migrate một lần. */
export const LEGACY_PROJECTS_STORAGE_KEY = "video_editor_projects";
export const LEGACY_CONFIG_STORAGE_KEY = "app-config-v2";
