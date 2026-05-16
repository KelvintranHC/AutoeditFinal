import fs from "fs";
import path from "path";

const DATA_ROOT = path.join(process.cwd(), "data");
const PROJECTS_DIR = path.join(DATA_ROOT, "projects");
const APP_CONFIG_FILE = path.join(DATA_ROOT, "app-config.json");

export interface StoredProject {
  id: string;
  userId: string;
  title: string;
  script: string;
  scenes: string;
  visualKeywordDirection?: string;
  pacingProfileJson?: string;
  audioUrl?: string | null;
  downloadUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserAppConfigPayload {
  transcriptionModel: string;
  analysisModel: string;
  exportResolution: string;
  geminiApiKey: string;
  storyblocksProxies: string;
  storyblocksCookies: string;
  driveAccessToken: string;
}

export interface StoredAppConfig {
  config: UserAppConfigPayload;
  updatedAt: string;
}

function ensureDirs() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.mkdirSync(DATA_ROOT, { recursive: true });
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function projectFilePath(projectId: string): string {
  return path.join(PROJECTS_DIR, `${safeId(projectId)}.json`);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (e) {
    console.warn("[projectStore] Corrupt file:", filePath, e);
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown) {
  ensureDirs();
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function listAllProjectFiles(): string[] {
  ensureDirs();
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(PROJECTS_DIR, f));
}

export function listAllProjects(): StoredProject[] {
  const projects: StoredProject[] = [];
  for (const file of listAllProjectFiles()) {
    const p = readJsonFile<StoredProject>(file);
    if (p) projects.push(p);
  }
  projects.sort(
    (a, b) =>
      new Date(b.updatedAt || b.createdAt).getTime() -
      new Date(a.updatedAt || a.createdAt).getTime(),
  );
  return projects;
}

export function getProject(projectId: string): StoredProject | null {
  return readJsonFile<StoredProject>(projectFilePath(projectId));
}

export function createProject(
  input: Omit<StoredProject, "createdAt" | "updatedAt" | "userId"> & {
    userId?: string;
  },
): StoredProject {
  const now = new Date().toISOString();
  const project: StoredProject = {
    userId: input.userId ?? "local",
    id: input.id,
    title: input.title,
    script: input.script ?? "",
    scenes: input.scenes ?? "",
    visualKeywordDirection: input.visualKeywordDirection ?? "",
    pacingProfileJson: input.pacingProfileJson ?? "",
    audioUrl: input.audioUrl ?? null,
    downloadUrl: input.downloadUrl ?? null,
    createdAt: now,
    updatedAt: now,
  };
  writeJsonFile(projectFilePath(project.id), project);
  return project;
}

export function updateProject(
  projectId: string,
  patch: Partial<
    Pick<
      StoredProject,
      | "title"
      | "script"
      | "scenes"
      | "visualKeywordDirection"
      | "pacingProfileJson"
      | "audioUrl"
      | "downloadUrl"
    >
  >,
): StoredProject | null {
  const existing = getProject(projectId);
  if (!existing) return null;
  const updated: StoredProject = {
    ...existing,
    ...patch,
    id: existing.id,
    userId: existing.userId,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(projectFilePath(projectId), updated);
  return updated;
}

export function deleteProject(projectId: string): boolean {
  const existing = getProject(projectId);
  if (!existing) return false;
  const fp = projectFilePath(projectId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  return true;
}

export function migrateProjects(
  incoming: StoredProject[],
): { migrated: number; skipped: number } {
  let migrated = 0;
  let skipped = 0;
  for (const raw of incoming) {
    if (!raw?.id || !raw.title) {
      skipped++;
      continue;
    }
    const normalized: StoredProject = {
      id: raw.id,
      userId: raw.userId || "local",
      title: String(raw.title).trim(),
      script: raw.script ?? "",
      scenes: raw.scenes ?? "",
      visualKeywordDirection: raw.visualKeywordDirection ?? "",
      pacingProfileJson: raw.pacingProfileJson ?? "",
      audioUrl: raw.audioUrl ?? null,
      downloadUrl: raw.downloadUrl ?? null,
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
    const onDisk = readJsonFile<StoredProject>(projectFilePath(normalized.id));
    if (
      !onDisk ||
      new Date(normalized.updatedAt).getTime() >=
        new Date(onDisk.updatedAt || onDisk.createdAt).getTime()
    ) {
      writeJsonFile(projectFilePath(normalized.id), normalized);
      migrated++;
    } else {
      skipped++;
    }
  }
  return { migrated, skipped };
}

export function getAppConfig(): StoredAppConfig | null {
  return readJsonFile<StoredAppConfig>(APP_CONFIG_FILE);
}

export function saveAppConfig(config: UserAppConfigPayload): StoredAppConfig {
  const stored: StoredAppConfig = {
    config,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(APP_CONFIG_FILE, stored);
  return stored;
}

/** Gộp config cũ theo user (nếu có) — lấy bản mới nhất làm shared config. */
export function bootstrapAppConfigFromLegacyUserConfigs(): StoredAppConfig | null {
  const legacyDir = path.join(DATA_ROOT, "user-configs");
  if (!fs.existsSync(legacyDir)) return null;
  let latest: StoredAppConfig | null = null;
  for (const f of fs.readdirSync(legacyDir).filter((x) => x.endsWith(".json"))) {
    const row = readJsonFile<{ config: UserAppConfigPayload; updatedAt: string }>(
      path.join(legacyDir, f),
    );
    if (!row?.config) continue;
    const candidate: StoredAppConfig = {
      config: row.config,
      updatedAt: row.updatedAt || new Date(0).toISOString(),
    };
    if (
      !latest ||
      new Date(candidate.updatedAt).getTime() > new Date(latest.updatedAt).getTime()
    ) {
      latest = candidate;
    }
  }
  if (latest) writeJsonFile(APP_CONFIG_FILE, latest);
  return latest;
}
