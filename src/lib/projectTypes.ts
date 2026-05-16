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
  createdAt: string;
  updatedAt: string;
}

export interface UserAppConfig {
  transcriptionModel: string;
  analysisModel: string;
  exportResolution: string;
  geminiApiKey: string;
  storyblocksProxies: string;
  storyblocksCookies: string;
  driveAccessToken: string;
}

/** Legacy localStorage key — chỉ dùng khi migrate một lần. */
export const LEGACY_PROJECTS_STORAGE_KEY = "video_editor_projects";
export const LEGACY_CONFIG_STORAGE_KEY = "app-config-v2";
