import type { Express } from "express";
import {
  bootstrapAppConfigFromLegacyUserConfigs,
  createProject,
  deleteProject,
  getAppConfig,
  getProject,
  listAllProjects,
  migrateProjects,
  saveAppConfig,
  updateProject,
  type StoredProject,
  type UserAppConfigPayload,
} from "./projectStore.js";

function parseConfigBody(body: unknown): UserAppConfigPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const src = (b.config as Record<string, unknown>) ?? b;
  return {
    transcriptionModel: String(src.transcriptionModel || ""),
    analysisModel: String(src.analysisModel || ""),
    exportResolution: String(src.exportResolution || "1080p"),
    geminiApiKey: String(src.geminiApiKey || ""),
    storyblocksProxies: String(src.storyblocksProxies || ""),
    storyblocksCookies: String(src.storyblocksCookies || ""),
    driveAccessToken: String(src.driveAccessToken || ""),
  };
}

function noCacheJson(res: import("express").Response) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

export function registerProjectRoutes(app: Express) {
  console.log("[API] Storage: shared JSON — không yêu cầu userId / X-User-Id");

  app.get("/api/projects", (_req, res) => {
    noCacheJson(res);
    res.json({ projects: listAllProjects() });
  });

  app.get("/api/projects/:projectId", (req, res) => {
    const project = getProject(req.params.projectId);
    if (!project) {
      return res.status(404).json({ error: "Project không tồn tại." });
    }
    res.json({ project });
  });

  app.post("/api/projects", (req, res) => {
    const title = String(req.body?.title || "").trim();
    if (!title) {
      return res.status(400).json({ error: "title là bắt buộc." });
    }
    const id =
      String(req.body?.id || "").trim() ||
      `proj_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const project = createProject({
      id,
      title,
      script: "",
      scenes: "",
      visualKeywordDirection: "",
      pacingProfileJson: "",
      audioUrl: null,
      downloadUrl: null,
    });
    res.status(201).json({ project });
  });

  app.patch("/api/projects/:projectId", (req, res) => {
    const patch = req.body || {};
    const allowed: Partial<StoredProject> = {};
    if (patch.title !== undefined) allowed.title = String(patch.title).trim();
    if (patch.script !== undefined) allowed.script = String(patch.script);
    if (patch.scenes !== undefined) {
      allowed.scenes =
        typeof patch.scenes === "string"
          ? patch.scenes
          : JSON.stringify(patch.scenes);
    }
    if (patch.visualKeywordDirection !== undefined) {
      allowed.visualKeywordDirection = String(patch.visualKeywordDirection);
    }
    if (patch.pacingProfileJson !== undefined) {
      allowed.pacingProfileJson =
        typeof patch.pacingProfileJson === "string"
          ? patch.pacingProfileJson
          : JSON.stringify(patch.pacingProfileJson);
    }
    if (patch.audioUrl !== undefined) allowed.audioUrl = patch.audioUrl;
    if (patch.downloadUrl !== undefined) allowed.downloadUrl = patch.downloadUrl;
    const updated = updateProject(req.params.projectId, allowed);
    if (!updated) {
      return res.status(404).json({ error: "Project không tồn tại." });
    }
    res.json({ project: updated });
  });

  app.delete("/api/projects/:projectId", (req, res) => {
    const ok = deleteProject(req.params.projectId);
    if (!ok) {
      return res.status(404).json({ error: "Project không tồn tại." });
    }
    res.json({ ok: true });
  });

  app.post("/api/projects/migrate", (req, res) => {
    const list = Array.isArray(req.body?.projects) ? req.body.projects : [];
    const result = migrateProjects(list as StoredProject[]);
    res.json({
      ok: true,
      projects: listAllProjects(),
      ...result,
    });
  });

  app.get("/api/user/config", (_req, res) => {
    noCacheJson(res);
    let stored = getAppConfig();
    if (!stored) {
      stored = bootstrapAppConfigFromLegacyUserConfigs();
    }
    if (!stored) {
      return res.json({ config: null });
    }
    res.json({ config: stored.config, updatedAt: stored.updatedAt });
  });

  app.put("/api/user/config", (req, res) => {
    const config = parseConfigBody(req.body?.config ?? req.body);
    if (!config) {
      return res.status(400).json({ error: "config không hợp lệ." });
    }
    const stored = saveAppConfig(config);
    res.json({ config: stored.config, updatedAt: stored.updatedAt });
  });
}
