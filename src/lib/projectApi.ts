import type { Project, UserAppConfig } from "./projectTypes";

const jsonHeaders: HeadersInit = {
  "Content-Type": "application/json",
};

const fetchOpts: RequestInit = { cache: "no-store" };

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data as { error?: string })?.error ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch("/api/projects", fetchOpts);
  const data = await parseJson<{ projects: Project[] }>(res);
  return data.projects || [];
}

export async function createProjectApi(
  title: string,
  id?: string,
): Promise<Project> {
  const res = await fetch("/api/projects", {
    ...fetchOpts,
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ title, id }),
  });
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

export type ProjectPatch = Partial<
  Pick<
    Project,
    | "title"
    | "script"
    | "scenes"
    | "visualKeywordDirection"
    | "pacingProfileJson"
    | "audioUrl"
    | "downloadUrl"
  >
>;

export async function updateProjectApi(
  projectId: string,
  patch: ProjectPatch,
): Promise<Project> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    ...fetchOpts,
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  });
  const data = await parseJson<{ project: Project }>(res);
  return data.project;
}

export async function deleteProjectApi(projectId: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    ...fetchOpts,
    method: "DELETE",
  });
  await parseJson<{ ok: boolean }>(res);
}

export async function migrateProjectsApi(
  projects: Project[],
): Promise<Project[]> {
  const res = await fetch("/api/projects/migrate", {
    ...fetchOpts,
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ projects }),
  });
  const data = await parseJson<{ projects: Project[] }>(res);
  return data.projects || [];
}

export async function fetchUserConfig(): Promise<UserAppConfig | null> {
  const res = await fetch("/api/user/config", fetchOpts);
  const data = await parseJson<{ config: UserAppConfig | null }>(res);
  return data.config;
}

export async function saveUserConfigApi(config: UserAppConfig): Promise<void> {
  const res = await fetch("/api/user/config", {
    ...fetchOpts,
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ config }),
  });
  await parseJson(res);
}
