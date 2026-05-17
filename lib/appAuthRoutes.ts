import type { Express, Request, Response } from "express";
import {
  createAppSessionToken,
  validateAppLogin,
  verifyAppSessionToken,
} from "./appAuth.js";

function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.startsWith("Bearer ")) {
    return h.slice(7).trim();
  }
  const body = req.body as { token?: string } | undefined;
  if (body?.token) return String(body.token);
  return null;
}

export function registerAppAuthRoutes(app: Express) {
  app.post("/api/auth/app-login", (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!validateAppLogin(username, password)) {
      return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu." });
    }
    const token = createAppSessionToken(username);
    res.json({ ok: true, token, username });
  });

  app.post("/api/auth/app-verify", (req, res) => {
    const token = bearerToken(req) || String(req.body?.token || "");
    const result = verifyAppSessionToken(token);
    if (!result.valid) {
      return res.status(401).json({ ok: false });
    }
    res.json({ ok: true, username: result.username });
  });

  app.post("/api/auth/app-logout", (_req, res) => {
    res.json({ ok: true });
  });
}

export function requireAppAuth(req: Request, res: Response): boolean {
  const token = bearerToken(req);
  const result = verifyAppSessionToken(token);
  if (!result.valid) {
    res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn." });
    return false;
  }
  return true;
}
