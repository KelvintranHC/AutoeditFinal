import crypto from "crypto";

const DEFAULT_USER = "Admin";
const DEFAULT_PASS = "Admin@68";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function authSecret(): string {
  return (
    process.env.APP_AUTH_SECRET ||
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
    "autoedit-local-auth-secret-change-me"
  );
}

export function getAppLoginCredentials(): { username: string; password: string } {
  return {
    username: process.env.APP_LOGIN_USER || DEFAULT_USER,
    password: process.env.APP_LOGIN_PASSWORD || DEFAULT_PASS,
  };
}

export function createAppSessionToken(username: string): string {
  const exp = Date.now() + SESSION_MS;
  const payload = `${username}:${exp}`;
  const sig = crypto
    .createHmac("sha256", authSecret())
    .update(payload)
    .digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export function verifyAppSessionToken(
  token: string | undefined | null,
): { valid: boolean; username?: string } {
  if (!token || typeof token !== "string") return { valid: false };
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const lastColon = decoded.lastIndexOf(":");
    if (lastColon <= 0) return { valid: false };
    const payload = decoded.slice(0, lastColon);
    const sig = decoded.slice(lastColon + 1);
    const secondColon = payload.indexOf(":");
    if (secondColon <= 0) return { valid: false };
    const username = payload.slice(0, secondColon);
    const exp = Number(payload.slice(secondColon + 1));
    if (!username || !Number.isFinite(exp) || Date.now() > exp) {
      return { valid: false };
    }
    const expected = crypto
      .createHmac("sha256", authSecret())
      .update(payload)
      .digest("hex");
    if (sig.length !== expected.length) return { valid: false };
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return { valid: false };
    }
    return { valid: true, username };
  } catch {
    return { valid: false };
  }
}

export function validateAppLogin(
  username: string,
  password: string,
): boolean {
  const creds = getAppLoginCredentials();
  const u = String(username || "").trim();
  const p = String(password || "");
  if (u.length === 0 || p.length === 0) return false;
  if (u.length !== creds.username.length || p.length !== creds.password.length) {
    return false;
  }
  const uOk = crypto.timingSafeEqual(
    Buffer.from(u),
    Buffer.from(creds.username),
  );
  const pOk = crypto.timingSafeEqual(
    Buffer.from(p),
    Buffer.from(creds.password),
  );
  return uOk && pOk;
}
