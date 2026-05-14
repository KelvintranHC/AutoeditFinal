console.log("Starting server...");
import { db, handleFirestoreError, OperationType } from "./src/lib/firebase.js";
import { doc, getDoc, setDoc } from "firebase/firestore";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import puppeteer from "puppeteer-extra";
// @ts-ignore
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import dotenv from "dotenv";

// Load environment variables immediately.
// Priority: .env.local (gitignored, user secrets) overrides .env (defaults).
dotenv.config({ path: ".env.local" });
dotenv.config(); // .env

// ------------------------------------------------------------
//  Crash protection for async Firestore failures.
//  The hard-coded Firebase config (AI Studio project) returns
//  PERMISSION_DENIED for non-authenticated writes; without this
//  handler such errors propagate as UnhandledRejection and kill
//  the server mid-pipeline. We log-and-ignore — Firestore is only
//  used for non-essential telemetry in local dev.
// ------------------------------------------------------------
process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message || String(reason);
  if (
    msg.includes("permission-denied") ||
    msg.includes("PERMISSION_DENIED") ||
    msg.includes("Missing or insufficient permissions")
  ) {
    console.warn("[Firestore] Ignored permission-denied (offline mode):", msg);
    return;
  }
  console.error("[UnhandledRejection]", reason);
});
process.on("uncaughtException", (err: any) => {
  const msg = err?.message || String(err);
  if (
    msg.includes("permission-denied") ||
    msg.includes("PERMISSION_DENIED") ||
    msg.includes("Missing or insufficient permissions")
  ) {
    console.warn("[Firestore] Ignored permission-denied (offline mode):", msg);
    return;
  }
  console.error("[UncaughtException]", err);
});

// Apply Stealth Plugin
puppeteer.use(StealthPlugin());

import fs from "fs";
import { execSync, spawnSync } from "child_process";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import os from "os";
import multer from "multer";
import { pipeline } from "@xenova/transformers";
import { pipeline as streamPipeline } from "node:stream/promises";
import https from "https";
import wavefile from "wavefile";
const { WaveFile } = wavefile;

const tempDirBase = os.tmpdir();

// Shared keep-alive HTTPS agent for CDN downloads (reused across requests).
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

// Upload concurrency guard — max 2 simultaneous Google Drive uploads to avoid
// hitting Drive API rate limits while still pipelining download → upload.
let activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = 2;

// Proxy tracking structures
interface ProxyMetric {
  proxyString: string;
  successCount: number;
  failCount: number;
  avgResponseTimeMs: number;
  isHealthy: boolean;
  lastTestedAt: number;
}

const proxyMetrics = new Map<string, ProxyMetric>();

function getBestProxy(proxiesFromUser: string[]): string | null {
  if (!proxiesFromUser || proxiesFromUser.length === 0) return null;

  // Register any new proxies
  for (const p of proxiesFromUser) {
    if (!proxyMetrics.has(p)) {
      proxyMetrics.set(p, {
        proxyString: p,
        successCount: 0,
        failCount: 0,
        avgResponseTimeMs: 0,
        isHealthy: true,
        lastTestedAt: 0,
      });
    }
  }

  const availableProxies = proxiesFromUser
    .map((p) => proxyMetrics.get(p)!)
    .filter((p) => !!p);
  let healthyProxies = availableProxies.filter((p) => p.isHealthy);

  if (healthyProxies.length === 0) {
    // If all are unhealthy, we retry all of them to give them a chance
    healthyProxies = availableProxies;
    healthyProxies.forEach((p) => (p.isHealthy = true));
  }

  // Sort by: Highest success rate, then lowest response time, then fewest tests
  healthyProxies.sort((a, b) => {
    const rateA =
      a.successCount + a.failCount > 0
        ? a.successCount / (a.successCount + a.failCount)
        : 1;
    const rateB =
      b.successCount + b.failCount > 0
        ? b.successCount / (b.successCount + b.failCount)
        : 1;

    if (rateA !== rateB) return rateB - rateA;

    if (a.avgResponseTimeMs !== b.avgResponseTimeMs) {
      if (a.avgResponseTimeMs === 0) return -1; // favor untested
      if (b.avgResponseTimeMs === 0) return 1;
      return a.avgResponseTimeMs - b.avgResponseTimeMs;
    }

    return a.failCount - b.failCount;
  });

  return healthyProxies[0].proxyString;
}

function updateProxyMetric(
  proxyString: string | null,
  success: boolean,
  durationMs: number,
) {
  if (!proxyString) return;
  const metric = proxyMetrics.get(proxyString);
  if (!metric) return;

  metric.lastTestedAt = Date.now();
  if (success) {
    if (metric.successCount === 0) {
      metric.avgResponseTimeMs = durationMs;
    } else {
      metric.avgResponseTimeMs = Math.round(
        (metric.avgResponseTimeMs * metric.successCount + durationMs) /
          (metric.successCount + 1),
      );
    }
    metric.successCount++;
    metric.isHealthy = true;
  } else {
    metric.failCount++;
    // Remove from rotation if it fails a lot, say >= 3 times and poor success rate
    if (
      metric.failCount >= 3 &&
      metric.successCount / (metric.successCount + metric.failCount) < 0.3
    ) {
      metric.isHealthy = false;
    }
  }
}

// Background health check that runs every 10 minutes, one at a time
let isCheckingProxies = false;
setInterval(
  async () => {
    if (isCheckingProxies) return;
    isCheckingProxies = true;
    try {
      const proxies = Array.from(proxyMetrics.values());
      for (const p of proxies) {
        // Test if untested for > 30 mins or if unhealthy
        if (Date.now() - p.lastTestedAt > 30 * 60 * 1000 || !p.isHealthy) {
          console.log(`[Proxy tester] Testing proxy: ${p.proxyString}`);
          try {
            const parts = p.proxyString.split(":");
            const args = [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-blink-features=AutomationControlled",
              "--disable-gpu",
              "--disable-dev-shm-usage",
            ];
            let auth = null;
            if (parts.length >= 2) {
              args.push(`--proxy-server=http://${parts[0]}:${parts[1]}`);
              if (parts.length >= 4)
                auth = { username: parts[2], password: parts[3] };
            }
            const browser = await puppeteer.launch({ 
              headless: true, 
              args,
              executablePath: getBrowserExecutablePath()
            });
            try {
              const page = await browser.newPage();
              await page.setDefaultNavigationTimeout(30000);
              if (auth) await page.authenticate(auth);
              const st = Date.now();
              await page.goto("https://www.storyblocks.com", {
                waitUntil: "domcontentloaded",
                timeout: 30000,
              });
              updateProxyMetric(p.proxyString, true, Date.now() - st);
              console.log(`[Proxy tester] ${p.proxyString} is healthy`);
            } finally {
              await browser.close();
            }
          } catch (e) {
            console.log(`[Proxy tester] ${p.proxyString} failed`);
            updateProxyMetric(p.proxyString, false, 15000);
          }
          // Delay between proxy tests to avoid CPU spikes
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    } finally {
      isCheckingProxies = false;
    }
  },
  10 * 60 * 1000,
);

let transcriber: any = null;
async function getTranscriber() {
  if (!transcriber) {
    console.log("Loading Whisper model...");
    transcriber = await pipeline(
      "automatic-speech-recognition",
      "Xenova/whisper-tiny",
    );
    console.log("Whisper model loaded.");
  }
  return transcriber;
}

function formatSRTTime(seconds: number): string {
  const date = new Date(0);
  date.setSeconds(seconds);
  const ms = Math.floor((seconds % 1) * 1000);
  return (
    date.toISOString().slice(11, 19) + "," + ms.toString().padStart(3, "0")
  );
}

/**
 * Pick an ffmpeg binary that actually runs on this machine.
 * `ffmpeg-static` often ships x86_64 only; on Apple Silicon without Rosetta,
 * spawn() fails with "Unknown system error -86". Prefer env / PATH / Homebrew.
 */
function ffmpegBinaryRuns(binPath: string): boolean {
  try {
    if (!binPath || !fs.existsSync(binPath)) return false;
    const r = spawnSync(binPath, ["-version"], { encoding: "utf8", timeout: 15_000 });
    return r.status === 0 && (r.stdout || "").includes("ffmpeg version");
  } catch {
    return false;
  }
}

function tryWhichFfmpeg(): string | null {
  try {
    if (process.platform === "win32") {
      const out = execSync("where.exe ffmpeg", { encoding: "utf8" })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      return out && fs.existsSync(out) ? out : null;
    }
    const out = execSync("command -v ffmpeg", { encoding: "utf8" }).trim();
    return out && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

function resolveFfmpegPath(): string | null {
  const candidates: string[] = [];
  const push = (p: string | undefined | null) => {
    const t = (p || "").trim();
    if (t) candidates.push(t);
  };
  push(process.env.FFMPEG_PATH);
  push(process.env.FFMPEG_BIN);
  push(tryWhichFfmpeg());
  if (process.platform === "darwin") {
    push("/opt/homebrew/bin/ffmpeg");
    push("/usr/local/bin/ffmpeg");
  }
  if (typeof ffmpegStatic === "string" && ffmpegStatic) {
    push(ffmpegStatic);
  }
  const seen = new Set<string>();
  for (const p of candidates) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (ffmpegBinaryRuns(p)) return p;
  }
  return null;
}

const resolvedFfmpegPath = resolveFfmpegPath();
if (resolvedFfmpegPath) {
  ffmpeg.setFfmpegPath(resolvedFfmpegPath);
  console.log(`[FFmpeg] Using: ${resolvedFfmpegPath}`);
} else {
  console.error(
    "[FFmpeg] Không tìm thấy binary chạy được. Trên Mac Apple Silicon: `brew install ffmpeg` " +
      "rồi thêm vào .env.local: FFMPEG_PATH=/opt/homebrew/bin/ffmpeg " +
      "(gói npm ffmpeg-static có thể chỉ là bản Intel, spawn sẽ lỗi -86 nếu không có Rosetta).",
  );
}

import { google } from "googleapis";

// ============================================================
//  GOOGLE DRIVE OAUTH 2.0 (server-side, no Firebase needed)
// ============================================================
//  Flow:
//    1. User hits /api/auth/google/login -> redirected to Google consent
//    2. Google redirects back to /api/auth/google/callback with `code`
//    3. We exchange code for refresh_token + access_token, save to disk
//    4. All Drive operations use stored refresh_token to auto-renew
// ------------------------------------------------------------
const DRIVE_TOKEN_FILE = path.join(process.cwd(), ".drive-token.json");
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const port = process.env.PORT || 3000;
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    `http://localhost:${port}/api/auth/google/callback`;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET in .env (see .env.example)"
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function loadStoredDriveTokens(): any | null {
  try {
    if (fs.existsSync(DRIVE_TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(DRIVE_TOKEN_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("[Drive] Failed to read stored tokens:", e);
  }
  return null;
}

function saveStoredDriveTokens(tokens: any) {
  fs.writeFileSync(DRIVE_TOKEN_FILE, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
}

function hasDriveConnection(): boolean {
  const t = loadStoredDriveTokens();
  return !!t?.refresh_token;
}

/**
 * Returns a googleapis OAuth2 client that auto-refreshes using the
 * stored refresh_token. The client emits a 'tokens' event whenever
 * Google issues a new access_token; we persist it so the next call
 * starts from a fresh state.
 */
function getDriveAuthClient(): InstanceType<typeof google.auth.OAuth2> {
  const stored = loadStoredDriveTokens();
  if (!stored?.refresh_token) {
    throw new Error(
      "Google Drive chưa được kết nối. Vui lòng bấm 'Connect Provider' trong tab Auth Cookies trước."
    );
  }
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials(stored);
  oauth2.on("tokens", (newTokens: any) => {
    const current = loadStoredDriveTokens() || {};
    const merged = {
      ...current,
      ...newTokens,
      // refresh_token is only sent on first authorize; keep the old one
      refresh_token: newTokens.refresh_token || current.refresh_token,
    };
    saveStoredDriveTokens(merged);
    console.log("[Drive] Access token auto-refreshed and persisted.");
  });
  return oauth2;
}

/**
 * Returns a fresh access_token using stored refresh_token.
 * Forces a refresh if expiry is within 60 seconds.
 */
async function getValidDriveAccessToken(): Promise<string> {
  const oauth2 = getDriveAuthClient();
  const stored = loadStoredDriveTokens();
  const now = Date.now();
  const needsRefresh =
    !stored.access_token ||
    !stored.expiry_date ||
    stored.expiry_date - 60_000 < now;
  if (needsRefresh) {
    const { credentials } = await oauth2.refreshAccessToken();
    const merged = {
      ...stored,
      ...credentials,
      refresh_token: credentials.refresh_token || stored.refresh_token,
    };
    saveStoredDriveTokens(merged);
    return merged.access_token!;
  }
  return stored.access_token;
}

/**
 * Resolves the auth to use for a Drive operation.
 *  - If server has stored OAuth credentials => use those (preferred, auto-refresh)
 *  - Otherwise fall back to a raw access_token passed from the frontend
 *    (legacy Firebase flow — still supported for backward compat)
 */
function resolveDriveAuth(
  providedAccessToken?: string | null
): InstanceType<typeof google.auth.OAuth2> {
  if (hasDriveConnection()) {
    return getDriveAuthClient();
  }
  if (providedAccessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: providedAccessToken });
    return auth;
  }
  throw new Error(
    "Google Drive chưa được kết nối. Setup OAuth (xem README) hoặc kết nối qua app."
  );
}

async function uploadToGoogleDrive(
  filePath: string,
  fileName: string,
  accessToken: string | null | undefined,
  folderId?: string
) {
  const auth = resolveDriveAuth(accessToken);
  const drive = google.drive({ version: "v3", auth });

  const fileMetadata: any = { name: fileName };
  if (folderId) fileMetadata.parents = [folderId];

  let fileSizeBytes = 0;
  try { fileSizeBytes = fs.statSync(filePath).size; } catch (_) {}

  // Stream directly from disk — no buffer in RAM.
  // High-watermark (1 MB) reduces I/O syscalls for large video files.
  const bodyStream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });

  const media = {
    mimeType: "video/mp4",
    body: bodyStream,
  };

  // Progress callback — fires periodically during upload.
  const onUploadProgress = (evt: { bytesRead: number }) => {
    const pct = fileSizeBytes > 0 ? Math.round((evt.bytesRead / fileSizeBytes) * 100) : 0;
    const readMB = (evt.bytesRead / 1_048_576).toFixed(1);
    const totalMB = fileSizeBytes > 0 ? `/${(fileSizeBytes / 1_048_576).toFixed(1)}` : "";
    console.log(`[Drive Upload] Progress: ${pct}% (${readMB}${totalMB} MB)`);
  };

  try {
    const file = await drive.files.create(
      {
        requestBody: fileMetadata,
        media,
        fields: "id, webViewLink, webContentLink",
        supportsAllDrives: true,
      },
      { onUploadProgress }
    );
    console.log(`[Drive Upload] Complete: "${fileName}" → ${file.data.id}`);
    return file.data;
  } catch (error: any) {
    if (
      error.message?.includes("auth") ||
      error.message?.includes("credential") ||
      error.message?.includes("401") ||
      error.message?.includes("invalid_grant")
    ) {
      throw new Error(
        `Google Drive Authentication Error: ${error.message}. Hãy bấm Re-sync Drive trong tab Auth Cookies.`
      );
    }
    throw new Error(`Google Drive Upload Failed: ${error.message}`);
  }
}

async function downloadFromGoogleDrive(
  fileId: string,
  accessToken: string | null | undefined,
  destPath: string
) {
  const auth = resolveDriveAuth(accessToken);
  const drive = google.drive({ version: "v3", auth });

  const dest = fs.createWriteStream(destPath);
  console.log(`[Drive] Downloading file ${fileId} to ${destPath}`);

  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  return new Promise<string>((resolve, reject) => {
    response.data
      .on("end", () => {
        console.log(`[Drive] Download complete: ${destPath}`);
        resolve(destPath);
      })
      .on("error", (err: any) => {
        console.error(`[Drive] Download error:`, err);
        reject(err);
      })
      .pipe(dest);
  });
}

puppeteer.use(StealthPlugin());

// Helper to find browser executable
function getBrowserExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  const platform = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch;         // 'arm64' | 'x64'

  // 1) Project-local .browser-cache (legacy & cross-platform)
  const localRoots = [
    path.join(process.cwd(), ".browser-cache"),
    path.join(process.cwd(), ".browser-profiles"),
  ];
  for (const root of localRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      const files = fs.readdirSync(root, { recursive: true }) as string[];
      const found = files.find(f =>
        f.endsWith("/chrome-headless-shell") ||
        f.endsWith("/chrome") ||
        f.endsWith("/chrome.exe") ||
        f.endsWith("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
      );
      if (found) return path.join(root, found);
    } catch (_) {}
  }

  // 2) Default Puppeteer cache: ~/.cache/puppeteer/chrome/<platform-version>/...
  try {
    const home = os.homedir();
    const ppCache = path.join(home, ".cache", "puppeteer", "chrome");
    if (fs.existsSync(ppCache)) {
      const versions = fs.readdirSync(ppCache).sort().reverse(); // newest-ish first
      for (const v of versions) {
        const base = path.join(ppCache, v);
        if (platform === "darwin") {
          const macBin = path.join(
            base,
            arch === "arm64" ? "chrome-mac-arm64" : "chrome-mac-x64",
            "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
          );
          if (fs.existsSync(macBin)) return macBin;
        } else if (platform === "linux") {
          const linBin = path.join(base, "chrome-linux64", "chrome");
          if (fs.existsSync(linBin)) return linBin;
        } else if (platform === "win32") {
          const winBin = path.join(base, "chrome-win64", "chrome.exe");
          if (fs.existsSync(winBin)) return winBin;
        }
      }
    }
  } catch (_) {}

  return undefined;
}

const app = express();
app.use(express.json({ limit: "50mb" }));

const activeJobs = new Map<
  string,
  {
    status: "processing" | "done" | "error";
    phase?: string;
    progress?: number;
    current?: string;
    downloadUrl?: string;
    error?: string;
    /** Server-side merge/export log lines for Console tab */
    logs?: string[];
  }
>();

/** Per-merge-job cancel + current ffmpeg kill hook */
const mergeRuntimeControls = new Map<
  string,
  { cancelled: boolean; killFfmpeg?: () => void }
>();

function appendMergeLog(mergeJobId: string, line: string) {
  const job = activeJobs.get(mergeJobId);
  if (!job) return;
  const logs = [...(job.logs ?? [])];
  const ts = new Date().toISOString().slice(11, 19);
  logs.push(`[${ts}] ${line}`);
  if (logs.length > 250) logs.splice(0, logs.length - 250);
  activeJobs.set(mergeJobId, { ...job, logs });
}

function mergeThrowIfCancelled(mergeJobId: string) {
  if (mergeRuntimeControls.get(mergeJobId)?.cancelled) {
    throw new Error("MERGE_CANCELLED: Đã hủy ghép video");
  }
}

function registerMergeFfmpegKill(mergeJobId: string, cmd: { kill: (s: string) => void }) {
  const rt = mergeRuntimeControls.get(mergeJobId);
  if (!rt) return;
  rt.killFfmpeg = () => {
    try {
      cmd.kill("SIGKILL");
    } catch (_) {}
  };
}

function clearMergeFfmpegKill(mergeJobId: string) {
  const rt = mergeRuntimeControls.get(mergeJobId);
  if (rt) rt.killFfmpeg = undefined;
}

function mergeResolutionDims(res: string | undefined): { w: number; h: number; label: string } {
  const r = (res || "1080p").toLowerCase().trim();
  if (r === "720p" || r === "720") return { w: 1280, h: 720, label: "720p" };
  if (r === "480p" || r === "480") return { w: 854, h: 480, label: "480p" };
  return { w: 1920, h: 1080, label: "1080p" };
}

/** Google Drive file id from explicit id or sharing URL (for merge + Firestore cache). */
function extractGoogleDriveFileId(input: string | undefined | null): string | null {
  if (input == null || typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  if (!/[/?]/.test(s) && /^[a-zA-Z0-9_-]{10,100}$/.test(s)) return s;
  const d = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (d) return d[1];
  const idq = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idq) return idq[1];
  return null;
}

// Ensure exports directory exists in temp
const exportsDir = path.join(tempDirBase, "video-editor-exports");
if (!fs.existsSync(exportsDir)) {
  fs.mkdirSync(exportsDir, { recursive: true });
}

// Ensure high-quality assets directory exists
function sanitizeForPath(val: string): string {
  if (!val) return "unnamed";
  const sanitized = val.replace(/[^a-z0-9_-]/gi, '_');
  // Maximum filename length is usually 255. We keep it safe at 64 chars total.
  if (sanitized.length > 48) {
    return sanitized.substring(0, 32) + "_" + crypto.createHash('md5').update(val).digest('hex').substring(0, 16);
  }
  return sanitized;
}

const hqAssetsDir = path.join(tempDirBase, "video-editor-hq-assets");
if (!fs.existsSync(hqAssetsDir)) {
  fs.mkdirSync(hqAssetsDir, { recursive: true });
}

function parseCookies(cookieStr: string) {
  if (!cookieStr) return [];
  const defaultDomain = ".storyblocks.com";
  
  // Try parsing as JSON first
  try {
    const parsed = JSON.parse(cookieStr);
    if (Array.isArray(parsed)) {
      console.log(`[HQ Download] Parsed ${parsed.length} cookies from JSON array.`);
      return parsed.map(c => ({
        name: c.name || c.key,
        value: c.value,
        domain: c.domain || defaultDomain,
        path: c.path || "/",
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? true,
        sameSite: c.sameSite || "Lax"
      })).filter(c => c.name && c.value);
    }
  } catch (e) {
    // Not valid JSON, fallback to manual parsing below
  }

  const cookies = cookieStr.split(";").map((pair) => {
    const trimmed = pair.trim();
    if (!trimmed) return null;
    const sepIdx = trimmed.indexOf("=");
    if (sepIdx === -1) return null;
    
    let name = trimmed.substring(0, sepIdx).trim();
    let value = trimmed.substring(sepIdx + 1).trim();
    
    // Remove wrapping quotes if present
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1);
    }
    
    if (!name || name.length > 256) return null;

    // Filter out restricted attributes that might be in the raw string
    const restrictedNames = ['domain', 'path', 'expires', 'secure', 'httponly', 'samesite', 'max-age'];
    if (restrictedNames.includes(name.toLowerCase())) return null;

    // Ensure value doesn't have illegal characters for Puppeteer
    value = value.replace(/[\x00-\x1F\x7F]/g, "");

    return {
      name: name,
      value: value,
      domain: defaultDomain,
      path: "/",
      secure: true,
      sameSite: "Lax" as const,
    };
  }).filter((c): c is any => c !== null);

  return cookies;
}

// ---------------------------------------------------------------------------
//  Human-likeness helpers for Storyblocks automation.
//  Stealth plugin handles navigator fingerprints; here we cover *behavior*:
//  - UA & viewport jitter (per-page)
//  - Smooth scroll-into-view + curved mouse motion before clicks
//  - Variable delays (gaussian-ish) and short pauses between micro-actions
// ---------------------------------------------------------------------------
const HUMAN_UA_POOL: string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7330.83 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7330.83 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
];
function pickUserAgent(): string {
  return HUMAN_UA_POOL[Math.floor(Math.random() * HUMAN_UA_POOL.length)];
}
function pickHumanViewport() {
  // Common laptop/desktop sizes with slight jitter
  const bases = [
    { w: 1280, h: 720 },
    { w: 1366, h: 768 },
    { w: 1440, h: 900 },
    { w: 1536, h: 864 },
  ];
  const b = bases[Math.floor(Math.random() * bases.length)];
  return {
    width: b.w + Math.floor(Math.random() * 20) - 10,
    height: b.h + Math.floor(Math.random() * 20) - 10,
    deviceScaleFactor: 1 + (Math.random() < 0.3 ? 1 : 0),
  };
}
function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const span = Math.max(0, maxMs - minMs);
  // Slight bell-curve via averaging two uniforms — feels less robotic than flat random
  const r = (Math.random() + Math.random()) / 2;
  return new Promise(r2 => setTimeout(r2, Math.round(minMs + r * span)));
}
async function humanScrollTo(page: any, element: any) {
  try {
    await element.evaluate((el: HTMLElement) => {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    });
    await humanDelay(500, 1200);
  } catch (_) {}
}
async function humanScrollPage(page: any) {
  // Mimic a quick visual scan of the page before interacting
  try {
    const steps = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < steps; i++) {
      const dy = 180 + Math.floor(Math.random() * 320);
      await page.mouse.wheel({ deltaY: dy }).catch(async () => {
        await page.evaluate((d: number) => window.scrollBy({ top: d, behavior: "smooth" }), dy);
      });
      await humanDelay(450, 1100);
    }
    // Scroll back near top before searching for the download CTA
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await humanDelay(600, 1100);
  } catch (_) {}
}
async function humanMoveAndClick(page: any, element: any) {
  try {
    const box = await element.boundingBox();
    if (!box) {
      await element.click();
      return;
    }
    const offsetX = (Math.random() - 0.5) * Math.min(box.width * 0.4, 24);
    const offsetY = (Math.random() - 0.5) * Math.min(box.height * 0.4, 10);
    const targetX = box.x + box.width / 2 + offsetX;
    const targetY = box.y + box.height / 2 + offsetY;
    // Hover approach in multi-step curve
    const steps = 18 + Math.floor(Math.random() * 14);
    await page.mouse.move(targetX, targetY, { steps });
    await humanDelay(140, 360);
    await page.mouse.down();
    await humanDelay(45, 130);
    await page.mouse.up();
  } catch (_) {
    try { await element.click(); } catch {}
  }
}
function isTransientStoryblocksError(msg: string): boolean {
  if (!msg) return false;
  return /TIMEOUT|EXPIRED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|cloudflare|Navigation timeout|net::ERR_|socket hang up|Target closed/i.test(msg);
}

/**
 * Returns true if the URL looks like a CDN media file that Chromium would block
 * when navigated to directly (ERR_BLOCKED_BY_CLIENT). Matches CloudFront, S3,
 * and Storyblocks' asset CDN domains serving video formats.
 */
function isCdnMediaUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const mediaExt = /\.(mp4|mov|avi|mkv|webm|m4v)(\?.*)?$/i.test(u.pathname);
    const cdnHost =
      u.hostname.includes("cloudfront.net") ||
      u.hostname.includes("amazonaws.com") ||
      u.hostname.endsWith(".akamaized.net") ||
      u.hostname.endsWith(".akamaihd.net") ||
      /^d[a-z0-9]+\.cloudfront\.net$/.test(u.hostname);
    return mediaExt && cdnHost;
  } catch {
    return false;
  }
}

/**
 * Downloads a CDN media URL via Node.js HTTP using session cookies.
 * Optimisations vs the old version:
 *  - Shared keep-alive HTTPS agent (connection reuse, lower TCP overhead).
 *  - `decompress: false` + `Accept-Encoding: identity` — skip double-decode
 *    overhead; CDN videos are already compressed.
 *  - 1 MB write-stream highWaterMark — fewer flush cycles, better throughput.
 *  - `streamPipeline()` — proper back-pressure + automatic cleanup on error.
 *  - Speed logging (MB/s) for operator visibility.
 *  - Transient-error retry (ECONNRESET / ETIMEDOUT / 5xx) with exp backoff.
 */
async function downloadUrlViaHttp(
  url: string,
  destDir: string,
  sessionCookies: Array<{ name: string; value: string }>,
  referer = "https://www.storyblocks.com/",
  retries = 2
): Promise<string> {
  const cookieHeader = sessionCookies.map(c => `${c.name}=${c.value}`).join("; ");
  const ext = url.split("?")[0].match(/\.(mp4|mov|avi|mkv|webm|m4v)$/i)?.[1] ?? "mp4";
  const destFile = path.join(destDir, `download_${Date.now()}.${ext}`);

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoffMs = 1500 * Math.pow(2, attempt - 1);
      console.log(`[HTTP Download] Retry ${attempt}/${retries} after ${backoffMs}ms (${url.slice(0, 80)}...)`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
    try {
      const startTime = Date.now();
      let bytesReceived = 0;

      const response = await axios.get(url, {
        responseType: "stream",
        timeout: 300_000,
        maxRedirects: 10,
        decompress: false,
        httpsAgent: keepAliveAgent,
        headers: {
          "Cookie": cookieHeader,
          "Referer": referer,
          "User-Agent": HUMAN_UA_POOL[0],
          "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "identity",
        },
      });

      const source = response.data as NodeJS.ReadableStream;
      source.on("data", (chunk: Buffer) => { bytesReceived += chunk.length; });

      const writer = fs.createWriteStream(destFile, { highWaterMark: 1 << 20 });
      await streamPipeline(source, writer);

      const elapsed = (Date.now() - startTime) / 1000;
      const sizeMB = (bytesReceived / 1_048_576).toFixed(1);
      const speedMBs = (bytesReceived / 1_048_576 / Math.max(elapsed, 0.1)).toFixed(2);
      console.log(`[HTTP Download] Done: ${sizeMB} MB in ${elapsed.toFixed(1)}s → ${speedMBs} MB/s`);

      const stat = fs.statSync(destFile);
      if (stat.size < 10_000) {
        fs.unlinkSync(destFile);
        throw new Error(`HTTP download too small (${stat.size} bytes) — likely an error response, not a video.`);
      }
      return destFile;

    } catch (err: any) {
      try { if (fs.existsSync(destFile)) fs.unlinkSync(destFile); } catch (_) {}
      const isTransient =
        err?.code === "ECONNRESET" ||
        err?.code === "ETIMEDOUT"  ||
        err?.code === "ECONNABORTED" ||
        (err?.response?.status != null && err.response.status >= 500);
      if (attempt < retries && isTransient) continue;
      throw err;
    }
  }
  throw new Error("downloadUrlViaHttp: exceeded max retries");
}

/**
 * ROOT-CAUSE FIX: navigating Chromium directly to a CloudFront `/watermarks/video/...mp4`
 * URL triggers `ERR_BLOCKED_BY_CLIENT` (Chrome heuristically blocks bare preview asset
 * navigations). We must always land on a Storyblocks product page.
 *
 * Pulls the 14–18 char asset hash out of any known URL shape:
 *   - storyblocks.com/video/stock/<slug>-<HASH>
 *   - <cdn>/watermarks/video/<HASH>/videoblocks-...mp4   (preview/watermark CDN)
 *   - <cdn>/videoblocks-...-<HASH>.mp4                    (direct asset CDN)
 */
function extractStoryblocksAssetId(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    // /watermarks/video/<ID>/...
    let m = u.pathname.match(/\/watermarks\/video\/([A-Za-z0-9_-]{10,})(?:\/|$)/);
    if (m) return m[1];
    // /video/stock/<slug>-<ID>
    m = u.pathname.match(/\/video\/stock\/(?:[^/]*-)?([A-Za-z0-9]{12,})(?:\/|$)/);
    if (m) return m[1];
    // Fallback: trailing hash before extension in any cdn path
    m = u.pathname.match(/[_-]([A-Za-z0-9]{12,})\.mp4$/);
    if (m) return m[1];
  } catch (_) {}
  return null;
}

function isStoryblocksProductPage(rawUrl: string): boolean {
  return /^https?:\/\/(www\.)?storyblocks\.com\/video\/stock\//i.test(rawUrl || "");
}

/**
 * Given any stockUrl (preview CDN or product page), resolve the **navigable**
 * Storyblocks page we should land on. For non-product URLs we route through
 * the Storyblocks search-by-id page; this page is always allowed by Chromium
 * and reliably surfaces the matching product card we can click.
 */
function resolveNavigationUrl(stockUrl: string): { url: string; needsResultClick: boolean; assetId: string | null } {
  if (isStoryblocksProductPage(stockUrl)) {
    return { url: stockUrl, needsResultClick: false, assetId: extractStoryblocksAssetId(stockUrl) };
  }
  const assetId = extractStoryblocksAssetId(stockUrl);
  if (assetId) {
    return {
      url: `https://www.storyblocks.com/video/search?searchTerm=${encodeURIComponent(assetId)}&sort=most_relevant`,
      needsResultClick: true,
      assetId,
    };
  }
  // Last resort: navigate as-is and let the existing error handlers surface the failure.
  return { url: stockUrl, needsResultClick: false, assetId: null };
}

/**
 * Downloads high quality video from Storyblocks using Puppeteer
 */
async function downloadHighQualityVideo(
  stockUrl: string,
  cookiesStr: string,
  projectId: string,
  clipId: string,
  jobId: string,
) {
  const diag = (m: string) => updateJobDiagnostic(projectId, jobId, m);
  // ROOT-CAUSE FIX: mark HQ browser busy for the *entire* job lifetime so the
  // idle-close interval cannot kill the browser mid-cookie-sync / mid-download
  // and surface as "Protocol error (Page.captureScreenshot): Session closed".
  markHqBusy();
  let hqReleased = false;
  const releaseHq = () => {
    if (!hqReleased) {
      hqReleased = true;
      markHqIdle();
    }
  };
  let browser: any;
  try {
    browser = await getHqBrowser();
  } catch (e) {
    releaseHq();
    throw e;
  }

  // ROOT-CAUSE FIX: Each job runs in an isolated BrowserContext (incognito-like)
  // so cookies, localStorage, modal state, and Chrome's internal download
  // routing do NOT leak across jobs. This eliminates the "2nd download stuck
  // in Awaiting file emission..." class of bugs caused by a stale browser-wide
  // download path pointing at job #1's already-deleted folder.
  let browserContext: any;
  let page: any;
  try {
    browserContext = await browser.createBrowserContext();
    page = await browserContext.newPage();
  } catch (e) {
    try { await browserContext?.close?.(); } catch (_) {}
    releaseHq();
    throw e;
  }

  // Compute the isolated download dir up-front and bind it to *this* browser
  // context via CDP. We use `browser.target().createCDPSession()` (browser
  // target, NOT page target) — only browser-target CDP can scope
  // `Browser.setDownloadBehavior` to a specific browserContextId.
  const safeProjectId = sanitizeForPath(projectId);
  const safeJobId = sanitizeForPath(jobId);
  const safeClipId = sanitizeForPath(clipId);
  const jobDownloadDir = path.join(hqAssetsDir, `${safeProjectId}_${safeJobId}_${Date.now()}`);
  if (!fs.existsSync(jobDownloadDir)) fs.mkdirSync(jobDownloadDir, { recursive: true });

  let cdpClient: any = null;
  /** Page-target CDP session for Network interception (must be function-scoped for `finally` detach). */
  let pageCdp: any = null;
  // Telemetry shared with the wait-for-file loop so we can distinguish
  // "Chrome refused the download" from "Chrome detected it but file is slow".
  let downloadEventSeen = false;
  let lastDownloadEvent: any = null;
  try {
    cdpClient = await browser.target().createCDPSession();
    await cdpClient.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: jobDownloadDir,
      browserContextId: (browserContext as any).id,
      eventsEnabled: true,
    });
    console.log(`[Downloader] Bound download path to context ${(browserContext as any).id}: ${jobDownloadDir}`);

    // CRITICAL diagnostic: subscribe to Chrome download events. If we click
    // Download but never see `Browser.downloadWillBegin`, the click did NOT
    // produce a network response with attachment disposition — meaning the
    // UI flow needs another step (modal Continue, format radio, etc.).
    cdpClient.on("Browser.downloadWillBegin", (e: any) => {
      downloadEventSeen = true;
      lastDownloadEvent = { type: "willBegin", ...e };
      console.log(`[Downloader][CDP] downloadWillBegin job=${jobId} url=${e.url} fileName=${e.suggestedFilename}`);
      diag(`Download starting: ${e.suggestedFilename}`);
    });
    cdpClient.on("Browser.downloadProgress", (e: any) => {
      lastDownloadEvent = { type: "progress", ...e };
      if (e.state === "completed") {
        console.log(`[Downloader][CDP] downloadCompleted job=${jobId} guid=${e.guid} bytes=${e.totalBytes}`);
      } else if (e.state === "canceled") {
        console.warn(`[Downloader][CDP] downloadCanceled job=${jobId} guid=${e.guid}`);
      }
    });
  } catch (cdpErr: any) {
    console.warn(`[Downloader] CDP setDownloadBehavior (browser-scoped) failed, retrying without contextId:`, cdpErr?.message);
    try {
      await cdpClient?.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: jobDownloadDir,
        eventsEnabled: true,
      });
    } catch (e2: any) {
      console.error(`[Downloader] CDP setDownloadBehavior fully failed:`, e2?.message);
    }
  }

  // Bind download path also for any NEW target (popup/new tab) that
  // Storyblocks may spawn from the Download click. We use Target.attachToTarget
  // via the browser-level CDP to ensure new targets in this context inherit
  // the same download path.
  const popupPages: any[] = [];
  browserContext.on("targetcreated", async (target: any) => {
    try {
      if (target.type() === "page") {
        console.log(`[Downloader] New target in context: ${target.url()}`);
        const popPage = await target.page().catch(() => null);
        if (popPage) {
          popupPages.push(popPage);
          // If the popup is the actual download URL, we keep it open so
          // Chrome can complete the download. Otherwise dismiss.
        }
      }
    } catch (_) {}
  });

  // Store page for live interaction
  const session = downloaderSessions.get(projectId);
  if (session) session.activePage = page;

  // Stream captures for Live Browser
  let streamActive = true;
  const captureStream = async () => {
    while (streamActive) {
      try {
        if (page.isClosed()) break;
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 40 });
        // Puppeteer 24+ returns Uint8Array, not Buffer.
        // Calling .toString('base64') on Uint8Array IGNORES the encoding
        // and emits "0,0,0,7,255,..." which makes the data URI invalid
        // (ERR_INVALID_URL in the Live Browser tab). Coerce via Buffer.from.
        const base64 = Buffer.from(screenshot).toString('base64');
        const session = downloaderSessions.get(projectId);
        if (session) {
           const job = session.jobs.find(j => j.id === jobId);
           if (job) {
             job.screenshot = `data:image/jpeg;base64,${base64}`;
             emitDownloaderUpdate(projectId);
           }
        }
      } catch (e) {
        // If screenshot fails, wait a bit longer or exit
        if (page.isClosed()) break;
      }
      await new Promise(r => setTimeout(r, 2000)); // Increased interval to 2s to save CPU
    }
  };
  captureStream();

  try {
    const vp = pickHumanViewport();
    await page.setViewport(vp);
    diag(`Initializing anti-detection... (vp=${vp.width}x${vp.height})`);
    // CRITICAL FIX (__name is not defined):
    //   tsx/esbuild compiles `const fire = (el) => {...}` to
    //   `const fire = __name((el) => {...}, "fire")` for stack-trace naming.
    //   When puppeteer serializes a page.evaluate(fn) callback via
    //   fn.toString() and sends it to the browser, those `__name` calls
    //   reference an identifier that does NOT exist in the page context →
    //   `ReferenceError: __name is not defined` aborts the automation
    //   ("Hệ thống tự động dừng" toast).
    //
    //   We inject a window.__name identity shim BEFORE every navigation.
    //   The shim is passed as a raw STRING (not a function) so esbuild
    //   itself can't transform it and create a self-referential trap.
    await page.evaluateOnNewDocument(
      "if (typeof window.__name === 'undefined') { window.__name = function (fn) { return fn; }; }"
    );

    // Lightweight anti-detection on top of puppeteer-extra-plugin-stealth.
    // Stealth handles most navigator fingerprints; we only patch leftovers.
    await page.evaluateOnNewDocument(() => {
       try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
       // @ts-ignore
       if (!window.chrome) { window.chrome = { runtime: {}, csi: () => ({}), loadTimes: () => ({}) }; }
       // Language pluralization (Storyblocks fingerprints "languages" length)
       try {
         Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
       } catch {}
    });

    diag("Configuring session tunnel...");
    const cookies = parseCookies(cookiesStr);
    if (cookies.length > 0) {
      console.log(`[HQ Download] Attempting to sync ${cookies.length} cookies...`);
      for (const cookie of cookies) {
        try {
          await page.setCookie(cookie);
        } catch (cookieErr: any) {
          console.warn(`[HQ Download] Skipping invalid cookie [${cookie.name}]: ${cookieErr.message}`);
          // Don't throw here, just skip the problematic cookie
        }
      }
      diag(`${cookies.length} security tokens synchronized.`);
    }

    // Rotate UA per page to avoid burst-fingerprint of N identical sessions.
    const ua = pickUserAgent();
    await page.setUserAgent(ua);
    // Plausible Accept-Language + Referer (simulate arriving from search)
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://www.storyblocks.com/video/search",
    });

    diag(`Accessing secure asset link...`);
    try {
      // ROOT-CAUSE FIX: never navigate directly to a CloudFront `.mp4` preview
      // URL — Chromium heuristically blocks bare media navigations and the
      // entire flow stalls at `ERR_BLOCKED_BY_CLIENT`. We resolve to a real
      // Storyblocks page (search-by-id when needed) first.
      const nav = resolveNavigationUrl(stockUrl);
      if (nav.needsResultClick) {
        diag(`Resolving Storyblocks page via search (asset=${nav.assetId})...`);
      }
      console.log(`[HQ Download] nav → ${nav.url} (resolved from ${stockUrl}, needsClick=${nav.needsResultClick})`);
      await page.goto(nav.url, { waitUntil: "domcontentloaded", timeout: 45000 });

      // If we landed on the search page, click the first matching product card
      // so the rest of the flow can find the Download button on the product page.
      if (nav.needsResultClick) {
        const productLinkSel = 'a[href^="/video/stock/"]';
        diag("Locating asset in search results...");
        const productLink = await page.waitForSelector(productLinkSel, { timeout: 30000 }).catch(() => null);
        if (!productLink) {
          throw new Error(`ASSET_NOT_FOUND: Storyblocks search returned no product cards for asset id ${nav.assetId || stockUrl}.`);
        }
        const productHref = await page.evaluate((el: any) => (el as HTMLAnchorElement).href, productLink);
        console.log(`[HQ Download] Clicking first search result → ${productHref}`);
        diag("Opening product page...");
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}),
          humanMoveAndClick(page, productLink).catch(() => productLink.click()),
        ]);
        await humanDelay(1500, 3000);
      }

      diag("Warming up engine...");
      
      // Wait for at least one major page indicator
      await page.waitForSelector('body', { timeout: 10000 });
      
      // CRITICAL: Session Verification with Race Condition
      diag("Verifying security handshake...");
      
      const authStatus = await Promise.race([
        page.waitForSelector('[data-testid="download-button"], .PrimaryButton, button[class*="Download"]', { timeout: 35000 }).then(() => 'SUCCESS'),
        page.waitForFunction(() => {
           const text = document.body.innerText.toLowerCase();
           return text.includes('log in') || text.includes('login') || text.includes('join now') || text.includes('sign in') || text.includes('create an account');
        }, { timeout: 35000 }).then(() => 'LOGIN_REQUIRED')
      ]).catch(() => 'TIMEOUT');

      if (authStatus === 'LOGIN_REQUIRED') {
         // Double verify to avoid false positives 
         const isMember = await page.$('[data-testid="member-menu-button"], .member-menu');
         if (!isMember) {
            console.error("[HQ Download] AUTH_FAILED: Landed on login screen.");
            throw new Error("AUTHENTICATION_FAILED: Your Storyblocks session cookies are invalid or expired. Please update them in the 'Auth Cookies' tab.");
         }
      }

      if (authStatus === 'TIMEOUT') {
         throw new Error("CONNECTION_TIMEOUT: Could not detect download UI or Login triggers within 35s. The page might be loading too slowly or Storyblocks layout has changed.");
      }

      const html = await page.content();

      if (html.includes("Just a moment...") || html.includes("cloudflare")) {
          diag("Bypassing Cloudflare protection...");
          await new Promise(r => setTimeout(r, 10000)); // Increased wait for stability
      }
      
      // Wait for at least one major Storyblocks element
      diag("Rendering product container...");
      await page.waitForSelector('.stockItemDetails, [data-testid="download-button"], .PrimaryButton', { timeout: 20000 });
      
    } catch (gotoErr: any) {
      console.error(`[HQ Download] Navigation error: ${gotoErr.message}`);
      if (gotoErr.message.includes("AUTHENTICATION_FAILED")) throw gotoErr;
      throw new Error(`CONNECTION_TIMEOUT: Could not establish a stable connection to the asset page (${gotoErr.message})`);
    }
    
    // Refresh screenshot immediately after navigation success
    const finalShot = await page.screenshot({ type: 'jpeg', quality: 60 });
    const session = downloaderSessions.get(projectId);
    if (session) {
      const job = session.jobs.find(j => j.id === jobId);
      if (job) {
        job.screenshot = `data:image/jpeg;base64,${Buffer.from(finalShot).toString('base64')}`;
        emitDownloaderUpdate(projectId);
      }
    }

    // Human-like delay after navigation: a real visitor reads the page first.
    await humanDelay(3500, 6500);
    // Casual scroll-scan of the page (mimics looking at preview & metadata).
    diag("Reviewing asset preview...");
    await humanScrollPage(page);

    // -----------------------------------------------------------------
    //  Quality pre-selection (REWRITTEN — see image_files/HTML the user gave)
    //
    //  The Storyblocks stock-item page shows a vertical radio list:
    //    ( ) 4KMOV (mjpeg) - 434.6 MB
    //    ( ) 4KMP4 (h264)  - 23.7 MB
    //    ( ) HDMOV (mjpeg) - 30.6 MB
    //    (●) HDMP4 (h264)  - 6.2 MB    <-- default in browser, but NOT
    //                                       guaranteed in a fresh incognito
    //                                       BrowserContext (no localStorage).
    //  If no radio is selected, clicking the yellow Download button is a
    //  no-op (Storyblocks shows an inline error). That is exactly the
    //  "click succeeded but no file emits" stall we kept seeing.
    //
    //  We try in this priority order: HDMP4 → 4KMP4 → HDMOV → 4KMOV
    //  (h264 is universally compatible; mjpeg/MOV are larger).
    // -----------------------------------------------------------------
    diag("Pre-selecting asset format...");
    const preSelectResult: {
      ok: boolean; target?: string; via?: string; labelText?: string;
      sizeBytes?: number | null; candidates?: Array<{ text: string; sizeBytes: number | null; via: string }>;
      debug?: any;
    } = await page.evaluate(() => {
        // ── helpers ──────────────────────────────────────────────────────────
        const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, "").toUpperCase();
        const visible = (el: Element): boolean => {
          const e = el as HTMLElement;
          if (!e.offsetParent && e.tagName !== "BODY") return false;
          const rect = e.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const fire = (el: HTMLElement) => {
          el.click();
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        // Parse "4.2 MB", "434.6 MB", "1.2 GB", "512 KB" → bytes (null if not found)
        const parseSizeBytes = (text: string): number | null => {
          const m = text.match(/([\d,.]+)\s*(KB|MB|GB)/i);
          if (!m) return null;
          const val = parseFloat(m[1].replace(/,/g, ""));
          if (isNaN(val)) return null;
          const unit = m[2].toUpperCase();
          if (unit === "KB") return val * 1024;
          if (unit === "MB") return val * 1024 * 1024;
          if (unit === "GB") return val * 1024 * 1024 * 1024;
          return null;
        };
        // Exclude audio-only, watermark, preview tracks
        const isExcluded = (text: string): boolean => {
          const t = text.toLowerCase();
          return t.includes("watermark") || t.includes("preview") ||
                 t.includes("audio only") || t.includes("mp3") ||
                 t.includes("wav") || t.includes("aiff") || t.includes("flac");
        };

        type Candidate = {
          el: HTMLElement;            // clickable target (row or input)
          input: HTMLInputElement | null;
          label: HTMLLabelElement | null;
          code: string;               // 'HDMP4' | '4KMP4' | 'HDMOV' | '4KMOV' | derived
          text: string;               // full row text (label + size line)
          sizeBytes: number | null;
          via: string;
        };
        const candidates: Candidate[] = [];
        const seenIds = new Set<string>();

        // ── PRIMARY (Storyblocks-specific): .formatSelector-row ─────────────
        //  Each row has id="HDMP4" / "4KMP4" / "HDMOV" / "4KMOV", contains an
        //  <input type="radio"> + <label> (short text "HD"/"4K") plus a sibling
        //  <div class="text-xs">HDMP4 (h264) — 6.2 MB</div>. The full innerText
        //  of the row holds BOTH so we can parse the size reliably.
        const sbRows = Array.from(document.querySelectorAll<HTMLElement>('.formatSelector-row'));
        for (const row of sbRows) {
          if (!visible(row)) continue;
          const code = (row.id || '').toUpperCase().replace(/\s+/g, '');
          if (!code || seenIds.has(code)) continue;
          const text = (row.innerText || row.textContent || '').trim();
          if (isExcluded(text)) continue;
          const input = row.querySelector<HTMLInputElement>('input[type="radio"]');
          const label = row.querySelector<HTMLLabelElement>('label');
          seenIds.add(code);
          candidates.push({
            el: (label || input || row) as HTMLElement,
            input, label, code, text,
            sizeBytes: parseSizeBytes(text),
            via: 'formatSelector-row',
          });
        }

        // ── FALLBACK 1: <input type="radio"> + <label> climbing ────────────
        //  When .formatSelector-row isn't present (older Storyblocks layouts).
        if (candidates.length === 0) {
          const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
          for (const r of radios) {
            if (!visible(r) && !visible(r.parentElement!)) continue;
            const label = r.id ? document.querySelector<HTMLLabelElement>(`label[for="${r.id}"]`) : null;
            // Climb to a parent container that likely holds the size string
            let row: HTMLElement = r;
            for (let i = 0; i < 4; i++) {
              if (row.parentElement) row = row.parentElement;
              const txt = (row.innerText || '').trim();
              if (/(MP4|MOV|MKV|AVI|WEBM)/i.test(txt) && /([\d,.]+)\s*(KB|MB|GB)/i.test(txt)) break;
            }
            const text = (row.innerText || label?.innerText || r.value || '').trim();
            if (isExcluded(text)) continue;
            const codeMatch = text.toUpperCase().match(/\b(4K\s?MP4|4K\s?MOV|HD\s?MP4|HD\s?MOV)\b/);
            const code = codeMatch ? codeMatch[1].replace(/\s+/g, '') : text.slice(0, 20).toUpperCase();
            if (seenIds.has(code)) continue;
            seenIds.add(code);
            candidates.push({
              el: (label || r) as HTMLElement,
              input: r, label, code, text,
              sizeBytes: parseSizeBytes(text),
              via: 'radio+label',
            });
          }
        }

        // ── FALLBACK 2: [role="radio"] custom (Radix-style) ───────────────
        if (candidates.length === 0) {
          for (const r of Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'))) {
            if (!visible(r)) continue;
            const text = (r.innerText || r.getAttribute('aria-label') || '').trim();
            if (!text || isExcluded(text)) continue;
            candidates.push({
              el: r, input: null, label: null,
              code: text.slice(0, 20).toUpperCase(),
              text,
              sizeBytes: parseSizeBytes(text),
              via: 'role=radio',
            });
          }
        }

        // ── debug snapshot ────────────────────────────────────────────────
        const debugSnapshot = sbRows.map(r => ({
          id: r.id,
          checked: r.querySelector<HTMLInputElement>('input[type="radio"]')?.checked ?? null,
          text: (r.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
        }));

        if (candidates.length === 0) return { ok: false, candidates: [], debug: debugSnapshot };

        const candidateLog = candidates.map(c => ({ text: c.text.slice(0, 100), sizeBytes: c.sizeBytes, via: c.via, code: c.code }));

        // ── PICK STRATEGY ────────────────────────────────────────────────
        //  User requirement: "mặc định HDMP4 để tải về nhanh nhất".
        //  1. If HDMP4 candidate(s) exist → pick the SMALLEST among HDMP4
        //     variants (h264 / hevc / etc).
        //  2. Else if any candidate has parsed size → pick the SMALLEST one
        //     across all candidates.
        //  3. Else → classic fallback priority HDMP4→4KMP4→HDMOV→4KMOV.
        // ─────────────────────────────────────────────────────────────────
        let chosen: Candidate | null = null;
        let pickReason = '';

        const hdmp4 = candidates.filter(c => c.code === 'HDMP4' || /\bHD\s?MP4\b/i.test(c.text));
        if (hdmp4.length > 0) {
          hdmp4.sort((a, b) => (a.sizeBytes ?? Number.MAX_SAFE_INTEGER) - (b.sizeBytes ?? Number.MAX_SAFE_INTEGER));
          chosen = hdmp4[0];
          pickReason = hdmp4.length > 1
            ? `HDMP4-preferred (smallest of ${hdmp4.length} variants)`
            : 'HDMP4-preferred';
        } else {
          const withSize = candidates.filter(c => c.sizeBytes !== null).sort((a, b) => a.sizeBytes! - b.sizeBytes!);
          if (withSize.length > 0) {
            chosen = withSize[0];
            pickReason = 'smallest-by-size (no HDMP4)';
          } else {
            const fallback = ['HDMP4', 'HD MP4', '4KMP4', '4K MP4', 'HDMOV', 'HD MOV', '4KMOV', '4K MOV'];
            for (const target of fallback) {
              const nt = norm(target);
              const found = candidates.find(c => norm(c.text).includes(nt) || norm(c.code).includes(nt));
              if (found) { chosen = found; pickReason = `priority-fallback (${target})`; break; }
            }
            if (!chosen) { chosen = candidates[0]; pickReason = 'first-visible (no signals)'; }
          }
        }

        if (!chosen) return { ok: false, candidates: candidateLog, debug: debugSnapshot };

        // ── fire the chosen option (label first, then input) ──────────────
        if (chosen.label) fire(chosen.label);
        fire(chosen.el);
        if (chosen.input) {
          chosen.input.checked = true;
          chosen.input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return {
          ok: true,
          target: chosen.code || chosen.text.slice(0, 30),
          via: `${chosen.via}/${pickReason}`,
          labelText: chosen.text.slice(0, 100),
          sizeBytes: chosen.sizeBytes,
          candidates: candidateLog,
          debug: debugSnapshot,
        };
      });

    let preSelected = preSelectResult.ok;
    if (preSelected) {
      const chosenMB = preSelectResult.sizeBytes ? ` (${(preSelectResult.sizeBytes / 1_048_576).toFixed(2)} MB)` : "";
      console.log(`[HQ Download] Candidate formats: ${JSON.stringify((preSelectResult.candidates || []).map(c => `${c.text}${c.sizeBytes ? " → " + (c.sizeBytes/1_048_576).toFixed(2)+"MB" : ""}`)  )}`);
      console.log(`[HQ Download] Chosen smallest: "${preSelectResult.target}"${chosenMB} via=${preSelectResult.via}`);
      diag(`Format active: ${preSelectResult.target}${chosenMB}`);
      // Settle so React updates state, then verify.
      await humanDelay(1200, 2400);

      // Verify a radio is actually checked. If not, fall back to clicking
      // the FIRST visible radio (any format is better than none).
      const isChecked = await page.evaluate(() => {
        const anyChecked = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).some(r => r.checked);
        const anyAria = Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]')).some(r => r.getAttribute("aria-checked") === "true");
        return anyChecked || anyAria;
      });
      if (!isChecked) {
        console.warn(`[HQ Download] Pre-select reported success but no radio is checked. Forcing first visible radio.`);
        await page.evaluate(() => {
          const r = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
            .find(el => (el as HTMLElement).offsetParent !== null);
          if (r) {
            const label = r.id ? document.querySelector<HTMLLabelElement>(`label[for="${r.id}"]`) : null;
            (label || r).click();
            r.checked = true;
            r.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
        await humanDelay(700, 1300);
      }
    } else {
      console.warn(`[HQ Download] Pre-select FAILED. radiosDetected=${(preSelectResult.debug || []).length}`);
      if (preSelectResult.debug && preSelectResult.debug.length > 0) {
        console.warn(`[HQ Download] Detected radios: ${JSON.stringify(preSelectResult.debug).slice(0, 500)}`);
      }
      diag("Format selector not found — proceeding (modal may appear).");
    }

    // ----------------------------------------------------------------
    //  Download button selection
    //  Storyblocks shows TWO download CTAs on a stock item page:
    //    1. Yellow "Download" button (.memberDownloadCta-cta .PrimaryButton)
    //       => the ORIGINAL high-quality file (4K/HD MP4/MOV)
    //    2. "Download Watermarked" link (.memberDownloadCta-detailActions)
    //       => preview clip with watermark
    //  We MUST click #1. The selectors below are ordered most-specific
    //  -> least-specific, and we always reject any element whose
    //  text/aria contains "watermark".
    // ----------------------------------------------------------------
    diag("Searching for download triggers...");
    const downloadSelectors = [
      ".memberDownloadCta-cta button.PrimaryButton",        // yellow Download (most specific)
      ".memberDownloadCta-cta .PrimaryButton",
      ".memberDownloadCta-cta button",
      "button.PrimaryButton.rounded-lg",
      "button[data-testid='download-button']",
      "button[class*='PrimaryButton']",
      "button[aria-label='Download']",                       // exact match, NOT 'Download Watermarked'
      "button.download-btn",
      "[class*='DownloadButton']",
    ];

    const isWatermarkEl = async (b: any): Promise<boolean> => {
      try {
        const txt = await b.evaluate((el: HTMLElement) => {
          const t = (el.textContent || "").toLowerCase();
          const a = (el.getAttribute("aria-label") || "").toLowerCase();
          const c = (el.className || "").toLowerCase();
          return `${t}|${a}|${c}`;
        });
        return txt.includes("watermark");
      } catch {
        return false;
      }
    };

    let foundBtn: any = null;
    for (const selector of downloadSelectors) {
      try {
        const btns = await page.$$(selector);
        for (const b of btns) {
          const isVisible = await b.isVisible();
          const text = await b.evaluate(
            (el: HTMLElement) => el.textContent || el.getAttribute("aria-label") || ""
          );
          const isWm = await isWatermarkEl(b);
          console.log(`[HQ Download] Try ${selector} | visible=${isVisible} watermark=${isWm} text="${text.trim().slice(0,60)}"`);
          if (isVisible && !isWm) {
            foundBtn = b;
            break;
          }
        }
        if (foundBtn) break;
      } catch (e) {}
    }

    // Fallback: scan all buttons by text but EXCLUDE anything containing "watermark"
    if (!foundBtn) {
      diag("Scanning page labels (watermark-filtered)...");
      const textBtn = await page.evaluateHandle(() => {
        const items = Array.from(
          document.querySelectorAll<HTMLElement>("button, a")
        );
        return items.find((el) => {
          const t = (el.textContent || "").toLowerCase();
          const a = (el.getAttribute("aria-label") || "").toLowerCase();
          const c = (el.className || "").toLowerCase();
          if (t.includes("watermark") || a.includes("watermark") || c.includes("watermark")) {
            return false;
          }
          // visible
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          return t.trim() === "download" || a === "download";
        });
      });
      if (textBtn.asElement()) {
        foundBtn = textBtn.asElement();
      }
    }

    if (!foundBtn) {
      throw new Error(
        "Could not find the (non-watermarked) Download button. " +
        "Đảm bảo tài khoản Storyblocks đã đăng nhập (cookies hợp lệ) và còn quota download."
      );
    }

    // Final safety check
    if (await isWatermarkEl(foundBtn)) {
      throw new Error("Refusing to click 'Download Watermarked' — aborting to avoid downloading the preview.");
    }
    {
      const finalText = await foundBtn.evaluate(
        (el: HTMLElement) => (el.textContent || el.getAttribute("aria-label") || "").trim()
      );
      console.log(`[HQ Download] Selected button: "${finalText}"`);
      diag(`Target: "${finalText}"`);
    }

    console.log(`[Downloader] Starting HQ download for ${safeClipId} in ${jobDownloadDir}`);
    diag(`Initializing isolated environment: ${jobDownloadDir.split('/').pop()}`);

    // ── CDN Navigation Interception ──────────────────────────────────────────
    // Storyblocks' Download button sometimes navigates the main frame directly
    // to the CloudFront CDN URL instead of triggering a proper file download.
    // Chromium blocks such navigations with ERR_BLOCKED_BY_CLIENT before the
    // response arrives, so CDP downloadWillBegin never fires → 60-second STALL.
    //
    // ───────────────────────────────────────────────────────────────────
    //  CDN-redirect capture (two layers, run in parallel)
    //
    //  Storyblocks' Download button triggers `location.href = <api>` which
    //  responds 302 → CloudFront `.mp4`. Chromium refuses to render the
    //  `.mp4` in the main frame (`ERR_BLOCKED_BY_CLIENT`). To survive this:
    //
    //   1. **Page-level CDP `Network.requestWillBeSent`** — catches EVERY
    //      request including each redirect hop. This is the *primary*
    //      capture path because it never misses a redirect.
    //   2. **Puppeteer `page.setRequestInterception` + page.on("request")**
    //      — catches main-frame navigations and aborts them so Chromium
    //      doesn't render the error page (less screen flicker, faster fail).
    //
    //  Either layer captures the URL → we then download via Node HTTP
    //  (`downloadUrlViaHttp`) using the session cookies → bypass Chromium.
    // ───────────────────────────────────────────────────────────────────
    let interceptedDownloadUrl: string | null = null;
    try {
      pageCdp = await page.target().createCDPSession();
      await pageCdp.send("Network.enable");
      pageCdp.on("Network.requestWillBeSent", (e: any) => {
        try {
          const url: string = e?.request?.url || "";
          if (!url || interceptedDownloadUrl) return;
          if (isCdnMediaUrl(url)) {
            console.log(`[HQ Download][CDP] Captured CDN request → ${url}`);
            interceptedDownloadUrl = url;
          }
        } catch (_) {}
      });
    } catch (cdpErr: any) {
      console.warn("[HQ Download] Page CDP Network.enable failed:", cdpErr?.message);
    }
    try {
      await page.setRequestInterception(true);
      page.on("request", (req: any) => {
        try {
          if (
            req.isNavigationRequest() &&
            req.frame() === page.mainFrame() &&
            isCdnMediaUrl(req.url())
          ) {
            if (!interceptedDownloadUrl) {
              interceptedDownloadUrl = req.url();
            }
            console.log(`[HQ Download] Intercepted CDN nav → ${req.url()}`);
            req.abort("aborted").catch(() => {});
          } else {
            req.continue().catch(() => {});
          }
        } catch (_) {
          req.continue().catch(() => {});
        }
      });
    } catch (interceptErr: any) {
      console.warn("[HQ Download] Could not enable request interception:", interceptErr?.message);
    }

    // Fix #5: Dismiss any modal/overlay (quota notice, "thanks for downloading",
    // newsletter prompt, etc.) that could intercept our click. Storyblocks
    // sometimes pops these on subsequent visits in the same browser session.
    try {
      await page.evaluate(() => {
        const dismissSel = [
          '[role="dialog"] [aria-label*="close" i]',
          '[role="dialog"] button[class*="close" i]',
          '[class*="modal"] [aria-label*="close" i]',
          '[class*="Modal"] [aria-label*="close" i]',
          '[class*="overlay"] [aria-label*="close" i]',
          'button[aria-label="Close"]',
          'button[aria-label="Dismiss"]',
          '[data-testid="modal-close"]',
          '[data-testid="close-button"]',
          'button[class*="dismiss" i]',
        ];
        for (const s of dismissSel) {
          document.querySelectorAll<HTMLElement>(s).forEach(el => {
            if (el.offsetParent !== null) el.click();
          });
        }
      });
      await humanDelay(400, 900);
    } catch (_) {}

    // Human-like prep: scroll into view, brief hesitation, then curve-move click.
    await humanScrollTo(page, foundBtn);
    await humanDelay(900, 2300);

    diag("Triggering download button click...");
    console.log(`[Downloader] Clicking download for job ${jobId} (preSelected=${preSelected})`);
    await humanMoveAndClick(page, foundBtn);

    // Give Chrome ~1.5s to fire downloadWillBegin BEFORE attempting modal
    // handling. If it fires we are done with the UI flow.
    await humanDelay(1200, 1800);

    // Quality Selection Logic (Dropdown style fallback)
    if (!preSelected) {
      try {
        // Small pause for dropdown to appear
        diag("Awaiting quality menu...");
        await page.waitForSelector("div[role='menu'], ul[role='listbox'], .dropdown, [class*='menu']", { timeout: 4000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));

        const qualityClicked = await page.evaluate(() => {
          const targets = ['4K', 'HD', 'SD', 'MP4'];
          const items = Array.from(document.querySelectorAll('li, button, span, a, [role="menuitem"]'));
          for (const target of targets) {
            const found = items.find(el => {
              const text = el.textContent?.toUpperCase() || '';
              return text.includes(target) && (el as HTMLElement).offsetParent !== null; // visible
            });
            if (found) {
              (found as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (qualityClicked) {
           diag("Profile selected via dynamic menu.");
           console.log(`[Downloader] Selected quality profile for job ${jobId}`);
        } else {
           diag("Defaulting to raw asset stream...");
           const items = await page.$$("li, button[role='menuitem']");
           if (items.length > 0) await items[0].click();
        }
      } catch (e) {
        diag("Direct stream initiated.");
      }
    } else {
      diag("Format verified. Binary transfer scheduled.");
    }

    // ----------------------------------------------------------------
    //  Post-click modal handler.
    //  Storyblocks (2024+) sometimes pops a *confirmation* modal AFTER the
    //  main Download click: e.g. "Confirm download", "Continue", "Download
    //  now", or radio for format selection. If we don't interact with it
    //  the network response never comes — that is the silent STALL case.
    //  Wait briefly to see if Chrome already started a download (CDP event);
    //  if not, scan the page for any plausible "confirm/download/continue"
    //  button inside a visible modal and click it.
    // ----------------------------------------------------------------
    if (!downloadEventSeen) {
      diag("Awaiting download dialog...");
      await humanDelay(1500, 2500);
    }

    if (!downloadEventSeen) {
      try {
        const confirmed = await page.evaluate(() => {
          // Helper: visible check
          const visible = (el: Element) => {
            const e = el as HTMLElement;
            if (!e.offsetParent && e.tagName !== "BODY") return false;
            const rect = e.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          // 1) Try common modal confirmation buttons by exact text first.
          const positiveTexts = ["download now", "confirm download", "confirm", "continue", "download", "agree"];
          const negativeTexts = ["watermark", "preview", "cancel", "close", "later"];
          const candidates = Array.from(document.querySelectorAll<HTMLElement>(
            'button, [role="button"], a[href*="download" i], input[type="submit"]'
          )).filter(el => visible(el));
          for (const t of positiveTexts) {
            const found = candidates.find(el => {
              const txt = (el.textContent || el.getAttribute("aria-label") || "").trim().toLowerCase();
              if (!txt) return false;
              if (negativeTexts.some(n => txt.includes(n))) return false;
              return txt === t || txt.startsWith(t + " ") || txt.endsWith(" " + t);
            });
            if (found) {
              found.click();
              return { clicked: true, label: (found.textContent || "").trim().slice(0, 80), via: "exact" };
            }
          }
          // 2) Fallback: inside any visible [role=dialog], click the primary action.
          const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="modal" i], [class*="Modal"]')).filter(visible);
          for (const dlg of dialogs) {
            const btn = Array.from(dlg.querySelectorAll<HTMLElement>('button, [role="button"]')).find(el => {
              const txt = (el.textContent || el.getAttribute("aria-label") || "").toLowerCase();
              if (!txt) return false;
              if (negativeTexts.some(n => txt.includes(n))) return false;
              return positiveTexts.some(p => txt.includes(p));
            });
            if (btn) {
              btn.click();
              return { clicked: true, label: (btn.textContent || "").trim().slice(0, 80), via: "dialog" };
            }
          }
          return { clicked: false };
        });
        if (confirmed.clicked) {
          console.log(`[HQ Download] Clicked post-modal confirm: "${confirmed.label}" (via ${confirmed.via})`);
          diag(`Confirmed download: ${confirmed.label}`);
          await humanDelay(800, 1500);
        } else {
          console.log(`[HQ Download] No post-click confirmation modal detected.`);
        }
      } catch (e: any) {
        console.warn(`[HQ Download] Post-click modal scan errored:`, e?.message);
      }
    }

    // ── HTTP Fallback: CDN URL was intercepted instead of a browser download ──
    // If the button click navigated to a CDN URL (intercepted & aborted above),
    // download it directly via Node.js HTTP using the session cookies.
    if (!downloadEventSeen && interceptedDownloadUrl) {
      console.log(`[HQ Download] Using HTTP fallback for intercepted URL: ${interceptedDownloadUrl}`);
      // Warn if URL smells like a watermark/preview — still attempt download
      // so the file size check (< 10 KB) and path check below can reject it.
      const lowerInterceptedUrl = interceptedDownloadUrl.toLowerCase();
      const isLikelyPreview = lowerInterceptedUrl.includes("/watermarks/") || lowerInterceptedUrl.includes("_preview") || lowerInterceptedUrl.includes("-preview");
      if (isLikelyPreview) {
        console.warn(`[HQ Download] Intercepted URL appears to be a PREVIEW/WATERMARK: ${interceptedDownloadUrl}`);
        diag("Warning: intercepted URL looks like a watermarked preview. Cookies may be expired or quality selector failed.");
      }
      diag("Downloading HD file via HTTP...");
      const httpFilePath = await downloadUrlViaHttp(
        interceptedDownloadUrl,
        jobDownloadDir,
        cookies,
        "https://www.storyblocks.com/"
      );
      if (isLikelyPreview) {
        try { fs.unlinkSync(httpFilePath); } catch (_) {}
        try { fs.rmSync(jobDownloadDir, { recursive: true, force: true }); } catch (_) {}
        throw new Error(
          `Intercepted URL is a PREVIEW/WATERMARKED file (path contains "/watermarks/"). ` +
          `Kiểm tra: cookies Storyblocks hết hạn chưa, hay quality selector cần update.`
        );
      }
      const finalPath = path.join(hqAssetsDir, `${safeProjectId}_${safeClipId}.mp4`);
      console.log(`[Downloader] Finalizing (HTTP): ${httpFilePath} → ${finalPath}`);
      fs.renameSync(httpFilePath, finalPath);
      try { fs.rmSync(jobDownloadDir, { recursive: true, force: true }); } catch (_) {}
      // Explicit success milestone for Console tab.
      try {
        const sizeBytes = fs.statSync(finalPath).size;
        const sizeMB = (sizeBytes / 1_048_576).toFixed(2);
        diag(`✅ Download success — ${sizeMB} MB saved locally.`);
        console.log(`[Downloader] ✅ DOWNLOAD SUCCESS job=${jobId} size=${sizeMB}MB path=${finalPath}`);
      } catch (_) {
        diag("✅ Download success.");
      }
      return finalPath;
    }

    // Wait for download to finish
    diag("Synchronizing with binary stream...");
    const startTime = Date.now();
    const JOB_TIMEOUT = 240000; // 4 minute hard cap
    // Stall detection: if no byte appears in the download dir for STALL_MS,
    // assume the click silently failed (modal blocked / quota / Chrome ignored
    // the CDP behavior) and fail fast instead of waiting the whole 4 minutes.
    const STALL_MS = 60_000;
    let lastProgressAt = Date.now();
    let lastTotalBytes = 0;

    while (Date.now() - startTime < JOB_TIMEOUT) {
      // Fix #1: honour the Stop System button immediately, do not wait 4 minutes.
      if (downloaderCancellation.get(projectId)) {
        try { fs.rmSync(jobDownloadDir, { recursive: true, force: true }); } catch (_) {}
        throw new Error("USER_CANCELLED: Stop requested by user");
      }
      if (page.isClosed()) throw new Error("Browser page closed unexpectedly during download.");

      if (!fs.existsSync(jobDownloadDir)) {
         throw new Error(`Download directory disappeared: ${jobDownloadDir}`);
      }

      const files = fs.readdirSync(jobDownloadDir);
      const crdownload = files.find(f => f.endsWith('.crdownload') || f.endsWith('.part') || f.endsWith('.tmp'));

      // Track byte progress to differentiate "downloading slowly" from "nothing happening".
      let totalBytes = 0;
      for (const f of files) {
        try { totalBytes += fs.statSync(path.join(jobDownloadDir, f)).size; } catch (_) {}
      }
      if (totalBytes > lastTotalBytes) {
        lastTotalBytes = totalBytes;
        lastProgressAt = Date.now();
      }

      if (files.length > 0 && !crdownload) {
         // Sort by mtime to find the most recently finished file
         const newestFile = files
           .map(f => ({ name: f, path: path.join(jobDownloadDir, f), time: fs.statSync(path.join(jobDownloadDir, f)).mtimeMs }))
           .filter(f => f.name.endsWith('.mp4'))
           .sort((a, b) => b.time - a.time)[0];

         if (newestFile) {
            // Safety: refuse preview/watermarked files. Storyblocks names
            // the watermarked clip "...-preview.mp4". The original file
            // never has that suffix — it uses the stock ID, e.g. SBV-XXX.mp4.
            const lowerName = newestFile.name.toLowerCase();
            if (lowerName.includes("-preview.") || lowerName.includes("_preview.") || lowerName.includes("watermark")) {
               try { fs.unlinkSync(newestFile.path); } catch (e) {}
               try { fs.rmSync(jobDownloadDir, { recursive: true, force: true }); } catch (e) {}
               throw new Error(
                  `Đã nhận file PREVIEW/WATERMARKED ("${newestFile.name}"). ` +
                  `Kiểm tra cookies Storyblocks (tài khoản đã đăng nhập + còn quota download) ` +
                  `hoặc UI Storyblocks đã thay đổi (cần update selector).`
               );
            }
            const finalPath = path.join(hqAssetsDir, `${safeProjectId}_${safeClipId}.mp4`);
            console.log(`[Downloader] Finalizing: Moving ${newestFile.path} -> ${finalPath} (source name="${newestFile.name}")`);
            fs.renameSync(newestFile.path, finalPath);
            try { fs.rmSync(jobDownloadDir, { recursive: true, force: true }); } catch(e) {}
            try {
              const sizeMB = (fs.statSync(finalPath).size / 1_048_576).toFixed(2);
              diag(`✅ Download success — ${sizeMB} MB saved locally.`);
              console.log(`[Downloader] ✅ DOWNLOAD SUCCESS job=${jobId} size=${sizeMB}MB path=${finalPath}`);
            } catch (_) {
              diag("✅ Download success.");
            }
            return finalPath;
         }
      }

      if (crdownload) {
        const mb = (totalBytes / 1_048_576).toFixed(1);
        diag(`Downloading... ${crdownload} (${mb} MB)`);
      } else {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const idleSec = Math.floor((Date.now() - lastProgressAt) / 1000);
        diag(`Awaiting file emission... (elapsed=${elapsed}s idle=${idleSec}s files=${files.length})`);
      }

      // Fix #2: Stall fail-fast — if nothing has hit the disk for STALL_MS,
      // the click did not produce a download. Bail out so the retry layer
      // can take over (instead of burning 4 minutes per stuck job).
      if (Date.now() - lastProgressAt > STALL_MS) {
        // Diagnostic snapshot for the operator: what's actually on the page?
        let pageInfo = "(unavailable)";
        try {
          pageInfo = await page.evaluate(() => {
            const out: any = { url: location.href, title: document.title };
            const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="modal" i], [class*="Modal"]'))
              .filter(el => (el.offsetParent !== null));
            out.dialogs = dialogs.map(d => (d.innerText || "").trim().slice(0, 200));
            const banners = Array.from(document.querySelectorAll<HTMLElement>('[class*="banner" i], [class*="toast" i], [class*="alert" i]'))
              .filter(el => (el.offsetParent !== null));
            out.banners = banners.map(b => (b.innerText || "").trim().slice(0, 200));
            out.bodyText = (document.body.innerText || "").slice(0, 400);
            return JSON.stringify(out);
          });
        } catch (_) {}
        console.error(`[Downloader] STALL diagnostic job=${jobId} cdpEventSeen=${downloadEventSeen} lastEvent=${JSON.stringify(lastDownloadEvent)} pageInfo=${pageInfo}`);
        try { fs.rmSync(jobDownloadDir, { recursive: true, force: true }); } catch (_) {}
        const hint = downloadEventSeen
          ? "Chrome reported the download started but the file never landed (download canceled or routed to wrong context)."
          : "Chrome did NOT see any download event — the click was absorbed by a modal/popup, quota exhausted, or Storyblocks UI changed.";
        throw new Error(`STALL: No file activity for ${STALL_MS / 1000}s. ${hint}`);
      }

      await new Promise(r => setTimeout(r, 3000));
    }

    // Cleanup on timeout
    try { fs.rmSync(jobDownloadDir, { recursive: true, force: true }); } catch(e) {}
    throw new Error(`Download timed out after 4 minutes in ${jobDownloadDir}`);
  } finally {
    streamActive = false;
    const session = downloaderSessions.get(projectId);
    if (session) {
       if (session.activePage === page) session.activePage = undefined;
       // Memory cleanup: Clear screenshot to free up memory after task
       const job = session.jobs.find(j => j.id === jobId);
       if (job && job.screenshot) {
          job.screenshot = undefined;
       }
    }
    // Detach CDP sessions BEFORE closing the context to avoid "Target closed" noise.
    try { await pageCdp?.detach?.(); } catch (_) {}
    try { await cdpClient?.detach?.(); } catch (_) {}
    try { await page.close(); } catch (_) {}
    // CRITICAL: dispose the per-job BrowserContext so cookies, localStorage,
    // and Chrome's download routing state cannot bleed into the next job.
    try { await browserContext.close(); } catch (_) {}
    // Release the HQ-busy guard *last* so the idle-close interval can only ever
    // run after this job is fully torn down.
    releaseHq();
  }
}

/**
 * Helper to download preview video via axios
 */
async function downloadPreviewVideo(url: string, destPath: string) {
  const response = await axios({
    method: "GET",
    url: url,
    responseType: "stream",
    timeout: 60000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
      Referer: "https://www.storyblocks.com/",
    },
  });
  const writer = fs.createWriteStream(destPath);
  response.data.pipe(writer);
  await new Promise<void>((resolve, reject) => {
    writer.on("finish", () => resolve());
    writer.on("error", (err) => reject(err));
  });

  const stats = fs.statSync(destPath);
  if (stats.size < 1000) {
    const buffer = fs.readFileSync(destPath);
    const contentSample = buffer.toString(
      "utf-8",
      0,
      Math.min(500, buffer.length),
    );
    console.log("File is too small, likely HTML/Error:", contentSample);
    throw new Error(
      "Downloaded file is too small or invalid (likely blocked by WAF)",
    );
  }
}

/** Exported merged video basename: drive_merge_mj_<uuid>.mp4 — chống path traversal. */
function isSafeMergedExportBasename(name: string): boolean {
  const n = path.basename(name);
  return /^drive_merge_mj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/i.test(n);
}

// Drive-based merge endpoints are registered after the automation downloader section (search for [DRIVE-MERGE]).

/** Tải file merge về máy (Content-Disposition: attachment). */
app.get("/api/exports/merged-download/:filename", (req, res) => {
  const basename = path.basename(req.params.filename || "");
  if (!isSafeMergedExportBasename(basename)) {
    return res.status(400).json({ error: "Tên file không hợp lệ." });
  }
  const full = path.join(exportsDir, basename);
  if (!fs.existsSync(full)) {
    return res.status(404).json({ error: "File không còn trên server." });
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${basename}"`);
  fs.createReadStream(full).pipe(res);
});

/** Upload file merge đã có trên server lên Google Drive. */
app.post("/api/drive/upload-merged", async (req, res) => {
  try {
    const { filename, driveToken, driveFolderId } = req.body || {};
    const basename = path.basename(typeof filename === "string" ? filename : "");
    if (!isSafeMergedExportBasename(basename)) {
      return res.status(400).json({ error: "Tên export không hợp lệ." });
    }
    const full = path.join(exportsDir, basename);
    if (!fs.existsSync(full)) {
      return res.status(404).json({ error: "File merge không tồn tại (có thể đã hết hạn trên server)." });
    }
    const uploadName = `merged_final_${Date.now()}.mp4`;
    const token = typeof driveToken === "string" ? driveToken.trim() : "";
    const folder =
      typeof driveFolderId === "string" && driveFolderId.trim() ? driveFolderId.trim() : undefined;
    const data = await uploadToGoogleDrive(full, uploadName, token || null, folder);
    return res.json({
      ok: true,
      id: data.id,
      webViewLink: data.webViewLink ?? null,
      webContentLink: data.webContentLink ?? null,
    });
  } catch (e: any) {
    console.error("[Drive] upload-merged failed:", e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// Serve exports
app.use("/exports", express.static(exportsDir));


app.post("/api/scrape", async (req, res) => {
  const keyword = typeof req.body.keyword === "string" ? req.body.keyword : "";
  const proxies = Array.isArray(req.body.proxies) ? req.body.proxies : [];

  if (!keyword) {
    return res.status(400).json({ error: "Keyword is required" });
  }

  let usedProxy = null;
  const scrapeStartTime = Date.now();

  try {
    const args = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ];
    let selectedProxyConfig: any = null;

    if (proxies && proxies.length > 0) {
      const bestProxy = getBestProxy(proxies);
      usedProxy = bestProxy;
      if (bestProxy) {
        // Parse proxy format: ip:port:user:pass
        const parts = bestProxy.split(":");
        if (parts.length >= 2) {
          const proxyServer = `${parts[0]}:${parts[1]}`;
          args.push(`--proxy-server=http://${proxyServer}`);
          if (parts.length >= 4) {
            selectedProxyConfig = { username: parts[2], password: parts[3] };
          }
        }
      }
    }

    let browser;
    let isGlobal = false;
    if (!selectedProxyConfig && (!proxies || proxies.length === 0)) {
      if (!(global as any).storyBlocksBrowser) {
         (global as any).storyBlocksBrowser = await puppeteer.launch({
           headless: true,
           args: args,
           executablePath: getBrowserExecutablePath()
         });
      }
      browser = (global as any).storyBlocksBrowser;
      isGlobal = true;
    } else {
      browser = await puppeteer.launch({
        headless: true,
        args: args,
        executablePath: getBrowserExecutablePath()
      });
    }

    const page = await browser.newPage();
    if (selectedProxyConfig) {
      await page.authenticate(selectedProxyConfig);
    }
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    );
    const url = `https://www.storyblocks.com/video/search?searchTerm=${encodeURIComponent(keyword)}&sort=most_relevant&quality=HD`;
    console.log("Scraping:", url);

    // We set a shorter timeout just in case it hangs
    await page
      .goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
      .catch((e) => console.log("Navigation timeout, proceeding..."));

    // Wait for WAF challenge to resolve and videos to render
    // Use waitForSelector to be more robust instead of a hardcoded wait
    try {
      await page.waitForSelector('video, [data-testid="search-result-card"], h1', { timeout: 15000 });
      // Extra pause for all DOM elements to settle
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch(err) {
      console.log("No videos or H1 found within timeout. Page might be very slow or blocked.");
      const html = await page.content();
      if (html.includes("Just a moment...")) {
        console.log("WAF Block intercepted for", keyword);
      }
    }

    // Attempt to extract video and stock URLs
    const videoData = await page
      .evaluate(() => {
        const results: {
          url: string;
          stockUrl: string;
          title: string;
          duration?: number;
        }[] = [];
        
        const cards = document.querySelectorAll('[data-testid="search-result-card"], a[href^="/video/stock/"]');
        let videos: HTMLVideoElement[] = [];
        if (cards.length > 0) {
           cards.forEach(c => {
             const v = c.querySelector('video');
             if (v) videos.push(v);
           });
        } else {
           videos = Array.from(document.querySelectorAll("video"));
        }
        
        for (let i = 0; i < videos.length; i++) {
          const v = videos[i];
          const videoUrl = v.src || v.querySelector("source")?.src;
          const aTag = v.closest("a");
          const stockUrl = aTag ? aTag.href : "";

          // Extract title from aria-label or title attribute of the anchor tag
          let title = "";
          if (aTag) {
            title =
              aTag.getAttribute("aria-label") ||
              aTag.getAttribute("title") ||
              "";
            // Remove common prefixes like "Stock Video: "
            title = title.replace(/^Stock Video:\s*/i, "");
          }

          // Try to find duration string (e.g., "00:15", "15s")
          let durationSec = 10; // Default
          const cardElem =
            v.closest('[data-testid="search-result-card"]') ||
            v.parentElement?.parentElement;
          if (cardElem) {
            const text =
              (cardElem as HTMLElement).innerText || cardElem.textContent || "";
            const durationMatch = text.match(/(\d+):(\d+)/);
            if (durationMatch) {
              durationSec =
                parseInt(durationMatch[1], 10) * 60 +
                parseInt(durationMatch[2], 10);
            }
          }

          if (videoUrl && videoUrl.includes(".mp4")) {
            if (!results.find((r) => r.url === videoUrl)) {
              results.push({
                url: videoUrl,
                stockUrl,
                title: title.trim() || "Untitled Video",
                duration: durationSec,
              });
              if (results.length >= 5) break;
            }
          }
        }
        return results;
      })
      .catch((err) => {
        console.error("page.evaluate error:", err);
        return [];
      });

    if (isGlobal) {
      await page.close().catch(() => {});
    } else {
      await browser.close().catch(() => {});
    }

    // Deduplicate by URL
    const uniqueMap = new Map<
      string,
      { url: string; stockUrl: string; title: string; duration?: number }
    >();
    if (videoData) {
      for (const item of videoData) {
        if (!uniqueMap.has(item.url)) {
          uniqueMap.set(item.url, item);
        }
        if (uniqueMap.size >= 5) break; // Only take 5 unique items
      }
    }
    const uniqueVideos = Array.from(uniqueMap.values());

    if (uniqueVideos.length > 0) {
      if (usedProxy) {
        updateProxyMetric(usedProxy, true, Date.now() - scrapeStartTime);
      }
      res.json({ videos: uniqueVideos, proxy: usedProxy });
    } else {
      // 0 results found, could be proxy blocked (like WAF not solved), could be no results
      // Assuming a success strictly from a connection standpoint, but let's record it as partial or success with low confidence?
      // For now, if puppeteer didn't crash, it means connection was fine.
      if (usedProxy) {
        updateProxyMetric(usedProxy, true, Date.now() - scrapeStartTime);
      }
      res.json({ videos: [], proxy: usedProxy });
    }
  } catch (error: any) {
    console.error("Scrape Error:", error);
    if (usedProxy) {
      updateProxyMetric(usedProxy, false, Date.now() - scrapeStartTime);
    }
    res
      .status(500)
      .json({ error: error.message || "Lỗi khi lấy video", proxy: usedProxy });
  }
});

const upload = multer({ 
  dest: path.join(tempDirBase, "video-editor-uploads"),
  limits: {
    fieldSize: 50 * 1024 * 1024, // 50MB for large scenes JSON
    fileSize: 200 * 1024 * 1024,  // 200MB for audio uploads
  }
});

let hqBrowser: any = null;
let hqInitPromise: Promise<any> | null = null;
let lastHqActivity = Date.now();
let hqJobCount = 0;
let hqActiveJobs = 0; // ROOT-CAUSE FIX: prevent idle-close from killing in-flight jobs
const MAX_IDLE_BROWSER = 10 * 60 * 1000; // 10 minutes idle before close
const MAX_JOBS_BEFORE_RESTART = 10;

export function markHqBusy() {
  hqActiveJobs++;
  lastHqActivity = Date.now();
}
export function markHqIdle() {
  hqActiveJobs = Math.max(0, hqActiveJobs - 1);
  lastHqActivity = Date.now();
}

// Cleanup idle browser context — but NEVER while a job is actively using it.
// Previously, the idle timer fired during cookie-sync of the first job because
// `lastHqActivity` was the module-load timestamp (stale by several minutes).
// We now bail out whenever `hqActiveJobs > 0` so an in-flight download can
// never have its browser yanked from under it.
setInterval(() => {
  if (!hqBrowser) return;
  if (hqActiveJobs > 0) {
    // keep timestamp warm while busy
    lastHqActivity = Date.now();
    return;
  }
  if (Date.now() - lastHqActivity > MAX_IDLE_BROWSER) {
    console.log("[HQ Browser] Closing idle browser instance...");
    hqBrowser.close().catch(() => {});
    hqBrowser = null;
    hqJobCount = 0;
  }
}, 30000);

async function getHqBrowser() {
  if (hqInitPromise) return hqInitPromise;

  // Check if we need to cycle or if it already exists
  if (hqBrowser && hqJobCount < MAX_JOBS_BEFORE_RESTART) {
    lastHqActivity = Date.now();
    hqJobCount++;
    return hqBrowser;
  }

  hqInitPromise = (async () => {
    try {
      // Force restart if too many jobs handled
      if (hqBrowser && hqJobCount >= MAX_JOBS_BEFORE_RESTART) {
         console.log("[HQ Browser] Cycling browser after job limit...");
         await hqBrowser.close().catch(() => {});
         hqBrowser = null;
         hqJobCount = 0;
      }

      if (!hqBrowser) {
        hqJobCount = 0;
        const userDataDir = path.join(process.cwd(), ".browser-profiles", "hq");
        if (!fs.existsSync(userDataDir)) {
          fs.mkdirSync(userDataDir, { recursive: true });
        } else {
          // ROOT-CAUSE FIX: previous server may have died via SIGKILL while a
          // Puppeteer-launched Chrome was alive. Chrome leaves SingletonLock
          // (symlink → "<hostname>-<PID>"), SingletonCookie and a SingletonSocket
          // unix-socket behind. Simply unlinking the files is NOT enough — the
          // OLD Chrome process is still listening on the IPC socket so the new
          // launch fails with `The browser is already running for ...`.
          //
          // Robust cleanup:
          //   1. Parse PID from SingletonLock target.
          //   2. If that PID is alive AND it's a Google-Chrome-for-Testing
          //      bound to *our* userDataDir → SIGKILL the whole process group.
          //   3. Unlink Lock + Cookie + Socket symlinks.
          //   4. Sleep so kernel releases the unix socket inode.
          try {
            const lockPath = path.join(userDataDir, "SingletonLock");
            const target = fs.readlinkSync(lockPath); // throws if missing
            const m = target.match(/-(\d+)$/);
            if (m) {
              const stalePid = parseInt(m[1], 10);
              try {
                // Verify the PID belongs to OUR Chrome instance before killing
                const psOut = execSync(`ps -p ${stalePid} -o command=`, { encoding: "utf8" }).trim();
                if (psOut.includes(userDataDir) || psOut.includes("Chrome for Testing")) {
                  console.log(`[HQ Browser] Killing stale Chrome PID ${stalePid} (target=${target})`);
                  try { process.kill(-stalePid, "SIGKILL"); } catch { try { process.kill(stalePid, "SIGKILL"); } catch {} }
                  // Also kill any sibling Chrome procs sharing our userDataDir
                  try {
                    const sibs = execSync(`pgrep -f "user-data-dir=${userDataDir}"`, { encoding: "utf8" })
                      .split("\n").map(s => parseInt(s, 10)).filter(Number.isFinite);
                    for (const pid of sibs) {
                      try { process.kill(pid, "SIGKILL"); } catch {}
                    }
                  } catch {}
                }
              } catch {
                // ps failed → PID gone already; safe to keep going
              }
            }
          } catch {
            // SingletonLock missing — nothing to do
          }
          const locks = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
          locks.forEach(lockName => {
            const lockFile = path.join(userDataDir, lockName);
            try {
              fs.unlinkSync(lockFile);
              console.log(`[HQ Browser] Removed stale ${lockName}`);
            } catch (e: any) {
              if (e?.code !== "ENOENT") {
                console.warn(`[HQ Browser] cleanup ${lockName}: ${e.message}`);
              }
            }
          });
          // Allow kernel to release the SingletonSocket inode before re-launch.
          await new Promise(r => setTimeout(r, 600));
        }

        console.log("[HQ Browser] Launching new instance...");
        hqBrowser = await puppeteer.launch({
          headless: true,
          userDataDir: userDataDir,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--use-fake-ui-for-media-stream",
            "--disable-infobars",
            "--window-size=1280,720",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--memory-pressure-thresholds=1",
            "--disable-extensions",
            "--disable-component-extensions-with-background-pages"
            // NOTE: do NOT pin --user-agent globally. We rotate per-page via
            // pickUserAgent() + page.setUserAgent() to keep the UA in sync
            // with the real Chrome binary and avoid burst-fingerprinting.
          ],
          executablePath: getBrowserExecutablePath()
        });
        
        // @ts-ignore
        hqBrowser.on('disconnected', () => {
          console.log("[HQ Browser] Disconnected");
          hqBrowser = null;
        });
        lastHqActivity = Date.now();
      }
      
      hqJobCount++;
      lastHqActivity = Date.now();
      return hqBrowser;
    } finally {
      hqInitPromise = null;
    }
  })();

  return hqInitPromise;
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Downloader Manager State
interface DownloaderJob {
  id: string; // unique ID for this download (e.g. video_{sceneIdx}_{videoIdx})
  stockUrl: string;
  stockTitle: string;
  status: "idle" | "downloading" | "uploading" | "success" | "error";
  diagnostic?: string;
  screenshot?: string; // Live capture
  driveLink?: string;
  driveFileId?: string;
  downloadDuration?: number;
  uploadDuration?: number;
  /** Byte size of the downloaded .mp4 (set after disk write; used for UI "Data Volume"). */
  fileSizeBytes?: number;
  error?: string;
}

const downloaderSessions = new Map<string, {
  projectId: string;
  jobs: DownloaderJob[];
  activePage?: any; // Active Puppeteer page
  clients: express.Response[];
  lastActivity: number;
}>();

// Cleanup inactive sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [projectId, session] of downloaderSessions.entries()) {
    if (now - session.lastActivity > 3600000 && session.clients.length === 0) {
      console.log(`[Downloader] Purging stale session: ${projectId}`);
      downloaderSessions.delete(projectId);
    }
  }
}, 3600000);

const downloaderCancellation = new Map<string, boolean>();
// Mutex: at most ONE background processing loop per project.
// Re-entrant calls (e.g. user clicks Retry on a single job while the main
// loop is still running) only append jobs into session.jobs — the existing
// loop will pick them up on its next iteration.
const downloaderRunning = new Map<string, boolean>();
// Auto-stop only after this many *consecutive* failures.
// Single transient errors (network, Cloudflare hiccups) are retried.
const MAX_CONSECUTIVE_FAILURES = 2;
const MAX_RETRIES_PER_JOB = 2;

function emitDownloaderUpdate(sessionId: string) {
  const session = downloaderSessions.get(sessionId);
  if (!session) return;
  session.lastActivity = Date.now();
  const data = JSON.stringify({ jobs: session.jobs });
  for (const client of session.clients) {
    client.write(`data: ${data}\n\n`);
  }
}

function updateJobDiagnostic(projectId: string, jobId: string, message: string) {
  const session = downloaderSessions.get(projectId);
  if (session) {
    const job = session.jobs.find(j => j.id === jobId);
    if (job) {
      job.diagnostic = message;
      emitDownloaderUpdate(projectId);
    }
  }
}

app.get("/api/downloader/events/:projectId", (req, res) => {
  const projectId = req.params.projectId;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  if (!downloaderSessions.has(projectId)) {
    downloaderSessions.set(projectId, { projectId, jobs: [], clients: [], lastActivity: Date.now() });
  }
  const session = downloaderSessions.get(projectId)!;
  session.lastActivity = Date.now();
  session.clients.push(res);

  // Send initial state
  res.write(`data: ${JSON.stringify({ jobs: session.jobs })}\n\n`);

  req.on("close", () => {
    session.clients = session.clients.filter((c) => c !== res);
  });
});

// ============================================================
//  GOOGLE OAUTH 2.0 ROUTES (replace Firebase Google sign-in)
// ============================================================
app.get("/api/auth/google/login", (req, res) => {
  try {
    const oauth2 = getOAuth2Client();
    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // force consent so we always get refresh_token
      scope: DRIVE_SCOPES,
    });
    res.redirect(url);
  } catch (e: any) {
    res.status(500).send(
      `<html><body style="font-family:system-ui;padding:2rem;background:#0e0e11;color:#fff"><h1>OAuth setup error</h1><pre>${e.message}</pre><p>Mở file <code>.env.local</code> và set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.</p></body></html>`
    );
  }
});

app.get("/api/auth/google/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;
  if (error) {
    return res.status(400).send(
      `<html><body style="font-family:system-ui;padding:2rem;background:#0e0e11;color:#fff"><h1>OAuth cancelled</h1><pre>${error}</pre></body></html>`
    );
  }
  if (!code) {
    return res.status(400).send("<h1>Missing ?code parameter</h1>");
  }
  try {
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      // refresh_token may not be returned if user already authorized previously
      // and we forgot to add prompt=consent — merge with existing if any
      const existing = loadStoredDriveTokens();
      if (existing?.refresh_token) {
        saveStoredDriveTokens({ ...existing, ...tokens, refresh_token: existing.refresh_token });
      } else {
        return res.status(500).send(
          `<html><body style="font-family:system-ui;padding:2rem;background:#0e0e11;color:#fff"><h1>No refresh_token received</h1><p>Vào https://myaccount.google.com/permissions, xoá ứng dụng cũ, rồi thử Connect lại.</p></body></html>`
        );
      }
    } else {
      saveStoredDriveTokens(tokens);
    }
    res.send(`<!DOCTYPE html>
<html><head><title>Drive Connected</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#0e0e11;color:#fff;
       display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .card{text-align:center;padding:3rem;border:1px solid rgba(255,255,255,.1);border-radius:12px}
  h1{margin:0 0 .5rem 0;font-size:1.5rem}
  p{margin:.5rem 0;opacity:.7;font-size:.9rem}
</style></head>
<body>
<div class="card">
  <div style="font-size:3rem">✅</div>
  <h1>Google Drive đã kết nối</h1>
  <p>Cửa sổ này sẽ tự đóng...</p>
</div>
<script>
  try { if (window.opener) window.opener.postMessage({type:'drive-oauth-success'}, '*'); } catch(e){}
  setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
</script>
</body></html>`);
  } catch (e: any) {
    console.error("[OAuth] Callback error:", e);
    res.status(500).send(
      `<html><body style="font-family:system-ui;padding:2rem;background:#0e0e11;color:#fff"><h1>OAuth exchange failed</h1><pre>${e.message}</pre></body></html>`
    );
  }
});

app.get("/api/auth/google/status", (req, res) => {
  const tokens = loadStoredDriveTokens();
  res.json({
    connected: !!tokens?.refresh_token,
    scope: tokens?.scope,
    expiresAt: tokens?.expiry_date || null,
  });
});

app.get("/api/auth/google/token", async (req, res) => {
  try {
    const accessToken = await getValidDriveAccessToken();
    res.json({ accessToken });
  } catch (e: any) {
    res.status(401).json({ error: e.message });
  }
});

app.post("/api/auth/google/logout", (req, res) => {
  try {
    if (fs.existsSync(DRIVE_TOKEN_FILE)) fs.unlinkSync(DRIVE_TOKEN_FILE);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/drive/folders", async (req, res) => {
  const accessToken = req.query.accessToken as string | undefined;
  try {
    const auth = resolveDriveAuth(accessToken);
    const drive = google.drive({ version: "v3", auth });

    const response = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: "files(id, name)",
      pageSize: 100,
      orderBy: "name",
    });

    res.json({ folders: response.data.files });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/downloader/start", async (req, res) => {
  let { projectId, videos, cookies, driveToken, driveFolderId } = req.body;
  if (!projectId || !videos || !Array.isArray(videos)) {
    return res.status(400).json({ error: "Invalid request format" });
  }

  // Load from cookies.json if empty
  if (!cookies) {
    try {
      const cookiesPath = path.join(process.cwd(), "cookies.json");
      if (fs.existsSync(cookiesPath)) {
        cookies = fs.readFileSync(cookiesPath, "utf-8");
        console.log("[Downloader] Loaded supplemental security tokens from cookies.json");
      }
    } catch (err) {
      console.warn("[Downloader] Failed to read cookies.json fallback:", err);
    }
  }

  // Clear any previous cancellation signal
  downloaderCancellation.set(projectId, false);
  res.json({ success: true, message: "Download session started" });

  if (!downloaderSessions.has(projectId)) {
    downloaderSessions.set(projectId, { projectId, jobs: [], clients: [], lastActivity: Date.now() });
  }
  const session = downloaderSessions.get(projectId)!;
  session.lastActivity = Date.now();

  // Initialize or update jobs
  for (const v of videos) {
    const existing = session.jobs.find((j) => j.id === v.id);
    if (!existing) {
      session.jobs.push({
        id: v.id,
        stockUrl: v.stockUrl,
        stockTitle: v.title,
        status: "idle",
      });
    } else if (existing.status === "error" || existing.status === "idle") {
      existing.status = "idle";
      existing.error = undefined;
      existing.fileSizeBytes = undefined;
    }
  }
  emitDownloaderUpdate(projectId);

  // Mutex: if a loop is already running for this project, just enqueue.
  // The active loop will pick up the new idle jobs on its next iteration.
  if (downloaderRunning.get(projectId)) {
    console.log(`[Downloader] Loop already running for ${projectId}; enqueued ${videos.length} job(s).`);
    return;
  }
  downloaderRunning.set(projectId, true);

  // Background Processing — single-flight, sequential, human-paced.
  (async () => {
    let consecutiveFailures = 0;
    try {
      while (true) {
        // Re-scan idle jobs every iteration so retry/append works mid-flight.
        const job = session.jobs.find(j => j.status === "idle");
        if (!job) break;

        if (downloaderCancellation.get(projectId)) {
          job.status = "error";
          job.error = "Operation cancelled by user";
          emitDownloaderUpdate(projectId);
          continue;
        }

        // Firestore short-circuit (already downloaded)
        const sanitizedUrl = encodeURIComponent(job.stockUrl);
        let downloadDoc;
        try {
          downloadDoc = await getDoc(doc(db, "videoDownloads", sanitizedUrl));
        } catch (error) {
          handleFirestoreError(error, OperationType.GET, "videoDownloads/" + sanitizedUrl);
        }
        if (downloadDoc && downloadDoc.exists()) {
          const data = downloadDoc.data() as {
            driveLink?: string;
            driveFileId?: string;
            fileSizeBytes?: number;
          };
          job.driveLink = data.driveLink;
          job.driveFileId =
            (typeof data.driveFileId === "string" && data.driveFileId.trim()) ||
            extractGoogleDriveFileId(data.driveLink) ||
            undefined;
          if (typeof data.fileSizeBytes === "number" && data.fileSizeBytes > 0) {
            job.fileSizeBytes = data.fileSizeBytes;
          }
          job.status = "success";
          consecutiveFailures = 0;
          emitDownloaderUpdate(projectId);
          continue;
        }

        // Per-job retry loop for *transient* errors only.
        let attempt = 0;
        let succeeded = false;
        let lastError: any = null;
        while (attempt <= MAX_RETRIES_PER_JOB) {
          if (downloaderCancellation.get(projectId)) break;

          const downloadStartTime = Date.now();
          job.status = "downloading";
          job.error = undefined;
          emitDownloaderUpdate(projectId);

          const clipId = `dl_${job.id}_${Date.now()}`;
          const downloadPromise = downloadHighQualityVideo(job.stockUrl, cookies, projectId, clipId, job.id);
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("JOB_EXPIRED: The operation took longer than 4 minutes and was terminated.")), 240000)
          );

          try {
            const downloadedFilePath = (await Promise.race([downloadPromise, timeoutPromise])) as string;
            job.downloadDuration = Math.round((Date.now() - downloadStartTime) / 1000);
            try {
              job.fileSizeBytes = fs.statSync(downloadedFilePath).size;
            } catch (_) {
              job.fileSizeBytes = undefined;
            }
            emitDownloaderUpdate(projectId);

            if (downloaderCancellation.get(projectId)) {
              job.status = "error";
              job.error = "Cancelled during download";
              try { fs.unlinkSync(downloadedFilePath); } catch (_) {}
              emitDownloaderUpdate(projectId);
              break;
            }

            if (driveToken) {
              // ── Background upload with concurrency guard ──────────────────
              // Wait if too many uploads are already in-flight (Drive rate limit).
              let waited = 0;
              while (activeUploads >= MAX_CONCURRENT_UPLOADS) {
                if (waited === 0) console.log(`[Downloader] Upload slots full (${activeUploads}/${MAX_CONCURRENT_UPLOADS}), waiting...`);
                await new Promise(r => setTimeout(r, 500));
                waited += 500;
              }

              const uploadStartTime = Date.now();
              job.status = "uploading";
              emitDownloaderUpdate(projectId);

              const fileName = `${job.stockTitle.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${Date.now()}.mp4`;
              const capturedFilePath = downloadedFilePath;
              const capturedJobRef = job;
              const capturedStockUrl = job.stockUrl;

              activeUploads++;
              // Fire upload promise without blocking the download loop.
              uploadToGoogleDrive(capturedFilePath, fileName, driveToken, driveFolderId)
                .then((driveRes) => {
                  capturedJobRef.driveLink = driveRes.webViewLink || driveRes.webContentLink || "";
                  capturedJobRef.driveFileId = driveRes.id ?? undefined;
                  capturedJobRef.uploadDuration = Math.round((Date.now() - uploadStartTime) / 1000);
                  if (capturedJobRef.status === "uploading") capturedJobRef.status = "success";
                  // Explicit upload success milestone for Console tab.
                  capturedJobRef.diagnostic = `✅ Upload success — ${capturedJobRef.uploadDuration}s. Link: ${capturedJobRef.driveLink.slice(0, 80)}`;
                  console.log(`[Drive Upload] ✅ UPLOAD SUCCESS job=${capturedJobRef.id} duration=${capturedJobRef.uploadDuration}s link=${capturedJobRef.driveLink}`);
                  emitDownloaderUpdate(projectId);
                  // Persist Drive link to Firestore (best-effort)
                  setDoc(doc(db, "videoDownloads", encodeURIComponent(capturedStockUrl)), {
                    stockUrl: capturedStockUrl,
                    driveLink: capturedJobRef.driveLink,
                    driveFileId: capturedJobRef.driveFileId ?? null,
                    fileSizeBytes: capturedJobRef.fileSizeBytes ?? null,
                    createdAt: new Date(),
                  }).catch((err: any) => {
                    handleFirestoreError(err, OperationType.WRITE, "videoDownloads/" + encodeURIComponent(capturedStockUrl));
                  });
                })
                .catch((err: any) => {
                  console.error(`[Drive Upload] ❌ UPLOAD FAILED job=${capturedJobRef.id}:`, err?.message);
                  if (capturedJobRef.status === "uploading") {
                    capturedJobRef.status = "error";
                    capturedJobRef.error = `Drive upload failed: ${(err?.message || "unknown").substring(0, 180)}`;
                  }
                  capturedJobRef.diagnostic = `❌ Upload failed: ${(err?.message || "unknown").substring(0, 100)}`;
                  emitDownloaderUpdate(projectId);
                })
                .finally(() => {
                  activeUploads--;
                  try { fs.unlinkSync(capturedFilePath); } catch (_) {}
                });
            } else {
              // No Drive token — mark success immediately, no upload needed.
              job.status = "success";
              emitDownloaderUpdate(projectId);
              try {
                await setDoc(doc(db, "videoDownloads", encodeURIComponent(job.stockUrl)), {
                  stockUrl: job.stockUrl,
                  driveLink: job.driveLink ?? "",
                  driveFileId: job.driveFileId ?? null,
                  fileSizeBytes: job.fileSizeBytes ?? null,
                  createdAt: new Date(),
                });
              } catch (error) {
                handleFirestoreError(error, OperationType.WRITE, "videoDownloads/" + encodeURIComponent(job.stockUrl));
              }
            }

            // Download succeeded — move on to next job regardless of upload state.
            succeeded = true;
            break;
          } catch (error: any) {
            lastError = error;
            const transient = isTransientStoryblocksError(error?.message || "");
            console.error(`[Downloader] Job ${job.id} attempt ${attempt + 1} failed${transient ? " (transient)" : ""}:`, error?.message);
            if (transient && attempt < MAX_RETRIES_PER_JOB && !downloaderCancellation.get(projectId)) {
              attempt++;
              // Exponential backoff with jitter — pretend the user "walks away" briefly.
              const backoffMs = (8000 + Math.random() * 7000) * attempt;
              job.diagnostic = `Transient error, retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES_PER_JOB + 1})...`;
              emitDownloaderUpdate(projectId);
              await new Promise(r => setTimeout(r, backoffMs));
              continue;
            }
            break;
          }
        }

        if (succeeded) {
          consecutiveFailures = 0;
          // Long, human-paced gap between successful jobs.
          await humanDelay(9000, 18000);
        } else {
          job.status = "error";
          job.error = (lastError?.message || "Unknown error").substring(0, 200);
          consecutiveFailures++;
          emitDownloaderUpdate(projectId);

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.warn(`[Downloader] Auto-stop: ${consecutiveFailures} consecutive failures on ${projectId}.`);
            downloaderCancellation.set(projectId, true);
            session.jobs.forEach(j => {
              if (j.id !== job.id && (j.status === "idle" || j.status === "downloading" || j.status === "uploading")) {
                j.status = "error";
                j.error = "AUTO_STOP: Preceding job failed";
              }
            });
            emitDownloaderUpdate(projectId);
            break;
          }
          // Cool-off before next job after a failure (rate-limit politeness).
          await humanDelay(15000, 25000);
        }
      }
    } finally {
      downloaderRunning.delete(projectId);
      downloaderCancellation.delete(projectId);
    }
  })();
});

app.post("/api/downloader/cancel", (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: "ProjectId required" });
  
  downloaderCancellation.set(projectId, true);
  
  // Set non-terminal jobs to terminated state for UI feedback
  const session = downloaderSessions.get(projectId);
  if (session) {
     session.jobs.forEach(j => {
        if (j.status === "idle" || j.status === "downloading" || j.status === "uploading") {
           j.status = "error";
           j.error = "SYSTEM_STOPPED";
        }
     });
     emitDownloaderUpdate(projectId);
  }
  
  res.json({ success: true, message: "Cancellation signal acknowledged" });
});

app.post("/api/downloader/interact", async (req, res) => {
  const { projectId, x, y, type, key } = req.body;
  const session = downloaderSessions.get(projectId);
  if (!session || !session.activePage) {
    return res.status(404).json({ error: "No active browser session" });
  }

  try {
    const page = session.activePage;
    if (type === "click") {
      await page.mouse.click(x * 1280, y * 720);
    } else if (type === "type" && key) {
      await page.keyboard.press(key);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/test-timeout", async (req, res) => {
  await new Promise((resolve) => setTimeout(resolve, 65000));
  res.json({ success: true, message: "Waited 65s" });
});

const activeTranscriptions = new Map<
  string,
  { status: "processing" | "done" | "error"; srt?: string; error?: string }
>();

app.post("/api/transcribe-local", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No audio file provided" });
  }

  const transactionId = uuidv4();
  activeTranscriptions.set(transactionId, { status: "processing" });

  res.json({ transactionId }); // Trả về ID ngay

  const originalExt = path.extname(req.file.originalname) || "";
  const inputPathWithExt = req.file.path + originalExt;
  fs.renameSync(req.file.path, inputPathWithExt);
  const inputPath = inputPathWithExt;

  const wavPath = path.join(tempDirBase, `${transactionId}_transcribe.wav`);

  // Processing background
  (async () => {
    try {
      // 1. Convert to 16kHz mono WAV for Whisper
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .toFormat("wav")
          .audioChannels(1)
          .audioFrequency(16000)
          .on("end", () => resolve())
          .on("error", (err) => reject(err))
          .save(wavPath);
      });

      // 2. Read wav file
      const buffer = fs.readFileSync(wavPath);
      const wav = new WaveFile(buffer);
      wav.toBitDepth("32f"); // Whisper expects 32-bit float
      wav.toSampleRate(16000);
      const audioData = wav.getSamples(
        false,
        Float32Array,
      ) as unknown as Float32Array;

      // 3. Transcribe
      const p = await getTranscriber();
      const output = await p(audioData, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
        language: "vietnamese",
        task: "transcribe",
      });

      // 4. Format to SRT
      let srt = "";
      if (
        output.chunks &&
        Array.isArray(output.chunks) &&
        output.chunks.length > 0
      ) {
        output.chunks.forEach((chunk: any, index: number) => {
          const start = formatSRTTime(chunk.timestamp[0] || 0);
          const end = formatSRTTime(
            chunk.timestamp[1] || chunk.timestamp[0] + 5,
          );
          srt += `${index + 1}\n${start} --> ${end}\n${chunk.text.trim()}\n\n`;
        });
      } else if (output.text && output.text.trim().length > 0) {
        srt = `1\n00:00:00,000 --> 00:00:10,000\n${output.text.trim()}\n\n`;
      } else {
        srt = `1\n00:00:00,000 --> 00:00:05,000\n(Không có nội dung)\n\n`;
      }

      activeTranscriptions.set(transactionId, { status: "done", srt });
    } catch (error: any) {
      console.error("Transcription error:", error);
      activeTranscriptions.set(transactionId, {
        status: "error",
        error: error.message || "Transcription failed",
      });
    } finally {
      // Cleanup
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

      // Dọn dẹp memory sau 10 phút
      setTimeout(() => {
        activeTranscriptions.delete(transactionId);
      }, 600000);
    }
  })();
});

app.get("/api/transcribe-status/:id", (req, res) => {
  const job = activeTranscriptions.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
});

app.post("/api/edit-video", upload.single("audio"), async (req, res) => {
  // Parsing scenes from body (sent as a string because of FormData)
  let scenes;
  try {
    scenes =
      typeof req.body.scenes === "string"
        ? JSON.parse(req.body.scenes)
        : req.body.scenes;
  } catch (e) {
    return res.status(400).json({ error: "Dữ liệu phân cảnh không hợp lệ" });
  }

  if (!scenes || !Array.isArray(scenes)) {
    return res.status(400).json({ error: "Dữ liệu phân cảnh không hợp lệ" });
  }

  const isFinal = req.body.isFinal === "true" || req.body.isFinal === true;
  const cookies = req.body.cookies || "";

  if (isFinal && !cookies) {
    return res.status(400).json({ error: "Cần cung cấp Cookie để tải bản đẹp" });
  }

  const projectId = uuidv4();
  const tempDir = path.join(tempDirBase, "video-editor-projects", projectId);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  let audioPath = null;
  if (req.file) {
    const originalExt = path.extname(req.file.originalname) || "";
    audioPath = req.file.path + originalExt;
    fs.renameSync(req.file.path, audioPath);
  }

  // Trả về projectId ngay lập tức để tránh timeout
  res.json({ projectId });
  activeJobs.set(projectId, { status: "processing" });

  // Processing in background
  (async () => {
    try {
      console.log(`Bắt đầu biên tập video cho project: ${projectId} (Final: ${isFinal})`);

      const clips: string[] = [];
      let clipCount = 0;

      // 1. Tải và cắt các clip
      for (const scene of scenes) {
        // Fallback: nếu selectedVideos trống, dùng selectedVideoIdx
        const segments =
          scene.selectedVideos && scene.selectedVideos.length > 0
            ? scene.selectedVideos
            : [
                {
                  videoIdx: scene.selectedVideoIdx || 0,
                  duration: scene.srtContext?.duration || 10,
                  startTimeOffset: 0,
                },
              ];

        for (const segment of segments) {
          const video = scene.videos[segment.videoIdx] || scene.videos[0];
          if (!video || !video.url) continue;

          const clipId = `clip_${clipCount++}`;
          const rawPath = path.join(tempDir, `${clipId}_raw.mp4`);
          const trimmedPath = path.join(tempDir, `${clipId}_trimmed.mp4`);

          if (isFinal && video.stockUrl) {
            // High Quality Mode - NEW PRIORITY: Cache -> Google Drive -> Puppeteer
            const driveToken = req.body.driveToken;
            const driveFileId = video.driveFileId;
            let success = false;

            // 1. Try Local Cache (hqAssetsDir)
            const safeParentId = sanitizeForPath(req.body.parentId || ""); 
            const safeClipId = sanitizeForPath(video.url);
            const cachedPath = path.join(hqAssetsDir, `${safeParentId}_${safeClipId}.mp4`);

            if (fs.existsSync(cachedPath)) {
              console.log(`[Final] Local cache hit: ${cachedPath}`);
              try {
                fs.copyFileSync(cachedPath, rawPath);
                success = true;
              } catch (copyErr) {
                console.error("[Final] Cache copy failed", copyErr);
              }
            }

            // 2. Try Google Drive if driveFileId exists
            if (!success && driveFileId && driveToken) {
               console.log(`[Final] Attempting Drive download for ${driveFileId}`);
               try {
                 await downloadFromGoogleDrive(driveFileId, driveToken, rawPath);
                 success = true;
               } catch (e) {
                 console.error("[Final] Drive download failed", e);
               }
            }

            // 3. Fallback to Puppeteer
            if (!success) {
               console.log(`[Final] Đang tải bản đẹp qua Playwright: ${video.stockUrl}`);
               try {
                 // clipId here is used for temp folder naming in downloadHighQualityVideo
                 const hqPath = await downloadHighQualityVideo(video.stockUrl, cookies, req.body.parentId || "global", clipId, video.url);
                 fs.copyFileSync(hqPath, rawPath);
                 success = true;
                 console.log(`[Final] Tải bản đẹp thành công: ${hqPath}`);
                 await new Promise(r => setTimeout(r, 5000));
               } catch (hqErr: any) {
                 console.error(`[Final] Lỗi tải bản đẹp, fallback về preview:`, hqErr);
                 await downloadPreviewVideo(video.url, rawPath);
               }
            }
          } else {
            // Preview Mode
            console.log(`[Preview] Đang tải clip: ${video.url}`);
            await downloadPreviewVideo(video.url, rawPath);
          }

          // Cắt và chuẩn hóa video bằng FFmpeg
          const originalDuration = video.duration || 10;
          const targetDuration = segment.duration;
          let startOffset = 0;
          let ffmpegCmd = ffmpeg(rawPath);

          if (targetDuration > originalDuration) {
            // Phân cảnh dài hơn video -> Loop video
            ffmpegCmd = ffmpegCmd.inputOptions(['-stream_loop', '-1']);
            startOffset = 0;
          } else {
            // Phân cảnh ngắn hơn video -> Cắt video
            startOffset = Math.max(0, (originalDuration - targetDuration) / 2);
          }

          console.log(
            `Đang chuẩn hóa clip ${clipId} (target: ${targetDuration}s, orig: ${originalDuration}s, offset: ${startOffset.toFixed(1)}s)`,
          );
          await new Promise<void>((resolve, reject) => {
            ffmpegCmd
              .setStartTime(startOffset)
              .setDuration(targetDuration)
              .videoFilters([
                "scale=1280:720:force_original_aspect_ratio=increase",
                "crop=1280:720",
                "setsar=1",
                "fps=30",
                "format=yuv420p"
              ])
              .videoCodec("libx264")
              .noAudio() // Loại bỏ âm thanh gốc của clip video
              .outputOptions([
                "-profile:v high",
                "-level:v 4.1",
                "-crf 18",
                "-preset slow",
                "-movflags +faststart"
              ])
              .on("end", () => resolve())
              .on("error", (err, stdout, stderr) => {
                console.error("FFmpeg processing error stdout:", stdout);
                console.error("FFmpeg processing error stderr:", stderr);
                reject(new Error(`Clip Normalization Error: ${err.message}\nStderr: ${stderr}`));
              })
              .save(trimmedPath);
          });

          clips.push(trimmedPath);
        }
      }

      if (clips.length === 0) {
        throw new Error("Không có clip nào được chọn để biên tập");
      }

      // 2. Ghép nội dung
      const intermediateVideoPath = path.join(tempDir, "no_audio_merged.mp4");
      const outputFilename = `final_${projectId}.mp4`;
      const outputPath = path.join(exportsDir, outputFilename);

      console.log(`Đang ghép ${clips.length} clips... (${isFinal ? 'Final' : 'Draft'})`);
      
      const listPath = path.join(tempDir, 'list.txt');
      const listContent = clips.map(clip => `file '${clip.replace(/'/g, "'\\''")}'`).join("\n");
      fs.writeFileSync(listPath, listContent);

      await new Promise<void>((resolve, reject) => {
        // Robust merge using re-encoding to ensure compatibility
        // Only use copy if absolutely identical, but for safety in AI Studio, re-encoding is better
        ffmpeg()
          .input(listPath)
          .inputOptions(['-f concat', '-safe 0'])
          .videoCodec('libx264')
          .videoFilters([
            "scale=1280:720:force_original_aspect_ratio=increase",
            "crop=1280:720",
            "setsar=1",
            "fps=30"
          ])
          .outputOptions([
            '-preset medium',
            '-crf 23',
            '-movflags +faststart',
            '-pix_fmt yuv420p'
          ])
          .on("error", (err, stdout, stderr) => {
             console.error("FFmpeg merge error stdout:", stdout);
             console.error("FFmpeg merge error stderr:", stderr);
             reject(new Error(`Merge Error: ${err.message}\nStderr: ${stderr}`));
          })
          .on("end", () => resolve())
          .save(intermediateVideoPath);
      });

      // 3. Ghép âm thanh nếu có
      if (audioPath && fs.existsSync(audioPath)) {
        console.log(`Đang lồng âm thanh gốc vào video...`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg(intermediateVideoPath)
            .input(audioPath)
            .outputOptions([
              "-c:v copy",
              "-c:a aac",
              "-movflags +faststart",
              "-map 0:v:0",
              "-map 1:a:0",
              "-shortest",
            ])
            .on("error", (err, stdout, stderr) => {
               console.error("FFmpeg final composite error stdout:", stdout);
               console.error("FFmpeg final composite error stderr:", stderr);
               reject(new Error(`Final Composite Error: ${err.message}\nStderr: ${stderr}`));
            })
            .on("end", () => resolve())
            .save(outputPath);
        });
      } else {
        console.log(`Đang chuẩn hóa metadata cuối cùng (faststart)...`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg(intermediateVideoPath)
            .outputOptions(["-c copy", "-movflags +faststart"])
            .on("error", (err, stdout, stderr) => {
               console.error("FFmpeg faststart error stdout:", stdout);
               console.error("FFmpeg faststart error stderr:", stderr);
               reject(new Error(`Faststart Error: ${err.message}\nStderr: ${stderr}`));
            })
            .on("end", () => resolve())
            .save(outputPath);
        });
      }

      activeJobs.set(projectId, {
        status: "done",
        downloadUrl: `/exports/${outputFilename}`,
      });
    } catch (error: any) {
      console.error("Lỗi biên tập video:", error);
      activeJobs.set(projectId, {
        status: "error",
        error: error.message || "Xử lý video thất bại",
      });
    } finally {
      // Cleanup temp files
      if (audioPath && fs.existsSync(audioPath)) {
        try {
          fs.unlinkSync(audioPath);
        } catch (e) {}
      }
      setTimeout(() => {
        fs.rm(tempDir, { recursive: true, force: true }, (err) => {
          if (err) console.error("Lỗi khi dọn dẹp dự án temp:", err);
        });
      }, 300000); // 5 mins debug window
    }
  })();
});

app.get("/api/edit-video-status/:projectId", (req, res) => {
  const job = activeJobs.get(req.params.projectId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
});

// ============================================================
// [DRIVE-MERGE] Merge Final Video — Drive-based HD clips
// POST /api/projects/:projectId/merge  (multipart/form-data)
//   fields: scenes (JSON string), driveToken?, audio? (file)
// GET  /api/projects/:projectId/merge-job/:mergeJobId
// ============================================================
app.post("/api/projects/:projectId/merge", upload.single("audio"), async (req, res) => {
  const { projectId } = req.params;

  let scenes: any[];
  try {
    scenes = typeof req.body.scenes === "string"
      ? JSON.parse(req.body.scenes)
      : req.body.scenes;
  } catch {
    return res.status(400).json({ error: "Invalid scenes JSON" });
  }

  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: "scenes must be a non-empty array" });
  }

  const driveTokenRaw: string | undefined = req.body.driveToken;
  const driveToken = typeof driveTokenRaw === "string" ? driveTokenRaw.trim() : "";
  const mergeResolutionRaw: string | undefined = req.body.mergeResolution;
  const { w: outW, h: outH, label: resLabel } = mergeResolutionDims(mergeResolutionRaw);
  const audioFile = (req as any).file as Express.Multer.File | undefined;

  const mergeJobId = `mj_${uuidv4()}`;
  const tempDir = path.join(tempDirBase, "drive-merges", mergeJobId);

  type MergeClipEntry = {
    clipId: string;
    rawPath: string;
    trimmedPath: string;
    driveFileId: string | null;
    targetDuration: number;
    startOffset: number;
  };

  const timeline: MergeClipEntry[] = [];
  let clipCount = 0;
  for (const scene of scenes) {
    const segments =
      scene.selectedVideos && scene.selectedVideos.length > 0
        ? scene.selectedVideos
        : [{ videoIdx: scene.selectedVideoIdx || 0, duration: scene.srtContext?.duration || 10, startTimeOffset: 0 }];

    for (const segment of segments) {
      const video = scene.videos?.[segment.videoIdx] ?? scene.videos?.[0];
      if (!video) continue;

      const clipId = `clip_${String(clipCount).padStart(3, "0")}`;
      const targetDuration = Math.max(0.5, segment.duration || scene.srtContext?.duration || 10);
      const originalDuration = video.duration || targetDuration;
      const startOffset =
        targetDuration > originalDuration ? 0 : Math.max(0, (originalDuration - targetDuration) / 2);

      const driveId =
        (typeof video.driveFileId === "string" && video.driveFileId.trim()) ||
        extractGoogleDriveFileId(video.driveLink) ||
        null;

      timeline.push({
        clipId,
        rawPath: path.join(tempDir, `${clipId}_raw.mp4`),
        trimmedPath: path.join(tempDir, `${clipId}.mp4`),
        driveFileId: driveId,
        targetDuration,
        startOffset,
      });
      clipCount++;
    }
  }

  if (timeline.length === 0) {
    return res.status(400).json({ error: "Không có clip nào trong timeline để merge." });
  }

  if (!driveToken) {
    return res.status(400).json({
      error:
        "Merge cần Google Drive: kết nối Drive và gửi access token (driveToken). " +
        "Chỉ ghép file gốc đã upload Drive — không dùng video watermark/proxy.",
    });
  }

  const missingDrive = timeline.filter((c) => !c.driveFileId).map((c) => c.clipId);
  if (missingDrive.length > 0) {
    return res.status(400).json({
      error:
        "Merge chỉ dùng bản gốc trên Google Drive (watermark chỉ để proxy edit). " +
        `Thiếu file Drive cho: ${missingDrive.slice(0, 8).join(", ")}${missingDrive.length > 8 ? "…" : ""}. ` +
        "Chạy pipeline tải HQ + upload Drive cho đến khi mỗi clip có Drive ID / link.",
      missingClipIds: missingDrive,
    });
  }

  const updateJob = (patch: object) => {
    const cur = activeJobs.get(mergeJobId) || { status: "processing" as const };
    activeJobs.set(mergeJobId, { ...cur, ...patch } as any);
  };

  mergeRuntimeControls.set(mergeJobId, { cancelled: false });
  activeJobs.set(mergeJobId, {
    status: "processing",
    phase: "queued",
    progress: 0,
    current: "Khởi động...",
    logs: [
      `[${new Date().toISOString().slice(11, 19)}] Merge — Drive HD only — ${resLabel} (${outW}×${outH})`,
    ],
  });
  res.json({ mergeJobId });

  (async () => {
    try {
      fs.mkdirSync(tempDir, { recursive: true });

      appendMergeLog(mergeJobId, `Bắt đầu — ${timeline.length} clip từ Drive, audio=${!!audioFile}`);
      console.log(`[Merge] Job ${mergeJobId} started — ${timeline.length} Drive clips, audio=${!!audioFile}, resolution=${resLabel}`);

      // ── Phase 1: Download from Drive only (max 3 parallel) — 0–40% ───────────
      const CONCURRENCY = 3;
      let completedDownloads = 0;

      for (let i = 0; i < timeline.length; i += CONCURRENCY) {
        mergeThrowIfCancelled(mergeJobId);
        const batch = timeline.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (clip) => {
            const fileId = clip.driveFileId as string;
            appendMergeLog(mergeJobId, `Tải Drive HD ${clip.clipId} (fileId=${fileId.slice(0, 12)}…)`);
            try {
              await downloadFromGoogleDrive(fileId, driveToken, clip.rawPath);
            } catch (e: any) {
              const em = (e?.message || "unknown").slice(0, 200);
              appendMergeLog(mergeJobId, `Drive lỗi ${clip.clipId}: ${em}`);
              throw new Error(`Drive tải thất bại ${clip.clipId}: ${em}`);
            }
            appendMergeLog(mergeJobId, `Đã tải xong ${clip.clipId}`);
            console.log(`[Merge] Drive file downloaded clip=${clip.clipId} fileId=${fileId}`);
          }),
        );
        completedDownloads += batch.length;
        const pct = Math.round((completedDownloads / timeline.length) * 40);
        updateJob({
          phase: "downloading",
          progress: pct,
          current: `Drive ${completedDownloads}/${timeline.length}`,
        });
        appendMergeLog(mergeJobId, `Batch Drive xong (${completedDownloads}/${timeline.length})`);
      }

      // ── Phase 2: Trim each clip to target duration — 40–70% ───
      const trimmedPaths: string[] = [];
      for (let i = 0; i < timeline.length; i++) {
        mergeThrowIfCancelled(mergeJobId);
        const clip = timeline[i];
        const pct = 40 + Math.round(((i + 1) / timeline.length) * 30);
        updateJob({ phase: "trimming", progress: pct, current: `Trimming clip ${i + 1}/${timeline.length}: ${clip.startOffset.toFixed(1)}s → ${(clip.startOffset + clip.targetDuration).toFixed(1)}s` });
        appendMergeLog(mergeJobId, `FFmpeg trim ${clip.clipId} → ${outW}×${outH}`);
        console.log(`[Merge] Trimming clip-${i}: ${clip.startOffset.toFixed(1)}s → ${(clip.startOffset + clip.targetDuration).toFixed(1)}s`);

        const cmd = ffmpeg(clip.rawPath)
          .setStartTime(clip.startOffset)
          .setDuration(clip.targetDuration)
          .videoFilters([
            `scale=${outW}:${outH}:force_original_aspect_ratio=increase`,
            `crop=${outW}:${outH}`,
            "setsar=1",
            "fps=30",
            "format=yuv420p",
          ])
          .videoCodec("libx264")
          .outputOptions(["-preset veryfast", "-crf 23", "-profile:v high", "-level:v 4.2", "-movflags +faststart"])
          .noAudio();

        registerMergeFfmpegKill(mergeJobId, cmd);

        await new Promise<void>((resolve, reject) => {
          cmd
            .on("end", () => {
              clearMergeFfmpegKill(mergeJobId);
              resolve();
            })
            .on("error", (err: Error, _stdout: string, stderr: string) => {
              clearMergeFfmpegKill(mergeJobId);
              appendMergeLog(mergeJobId, `Trim lỗi: ${stderr?.slice(0, 400) || err.message}`);
              reject(new Error(`Trim ${clip.clipId}: ${err.message}\n${stderr}`));
            })
            .save(clip.trimmedPath);
        });
        trimmedPaths.push(clip.trimmedPath);
      }

      // ── Phase 3: Concat demuxer (copy, no re-encode) — 70–85% ─
      mergeThrowIfCancelled(mergeJobId);
      updateJob({ phase: "concat", progress: 70, current: `Concatenating ${trimmedPaths.length} clips...` });
      appendMergeLog(mergeJobId, `Concat ${trimmedPaths.length} clip (-c copy)`);
      console.log(`[Merge] Concat ${trimmedPaths.length} clips`);

      const listPath = path.join(tempDir, "list.txt");
      fs.writeFileSync(listPath, trimmedPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

      const intermediatePath = path.join(tempDir, "no_audio.mp4");
      const concatCmd = ffmpeg()
        .input(listPath)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions(["-c copy", "-movflags +faststart"]);

      registerMergeFfmpegKill(mergeJobId, concatCmd);

      await new Promise<void>((resolve, reject) => {
        concatCmd
          .on("end", () => {
            clearMergeFfmpegKill(mergeJobId);
            resolve();
          })
          .on("error", (_err: Error, _stdout: string, stderr: string) => {
            clearMergeFfmpegKill(mergeJobId);
            appendMergeLog(mergeJobId, `Concat lỗi: ${stderr?.slice(0, 500) || _err.message}`);
            reject(new Error(`Concat demuxer: ${stderr}`));
          })
          .save(intermediatePath);
      });

      const concatSizeMB = (fs.statSync(intermediatePath).size / 1048576).toFixed(1);
      appendMergeLog(mergeJobId, `Concat xong (${concatSizeMB} MB)`);
      console.log(`[Merge] Concat done → ${intermediatePath} (${concatSizeMB} MB)`);

      // ── Phase 4: Audio mix (optional) — 85–95% ────────────────
      const outputFilename = `drive_merge_${mergeJobId}.mp4`;
      const outputPath = path.join(exportsDir, outputFilename);

      if (audioFile && fs.existsSync(audioFile.path)) {
        mergeThrowIfCancelled(mergeJobId);
        updateJob({ phase: "audio_mix", progress: 85, current: "Mixing background music..." });
        appendMergeLog(mergeJobId, "Mix nhạc nền (AAC -shortest)");
        console.log(`[Merge] Mixing background music`);

        const mixCmd = ffmpeg(intermediatePath)
          .input(audioFile.path)
          .outputOptions([
            "-c:v copy",
            "-c:a aac",
            "-b:a 192k",
            "-map 0:v:0",
            "-map 1:a:0",
            "-shortest",
            "-movflags +faststart",
          ]);

        registerMergeFfmpegKill(mergeJobId, mixCmd);

        await new Promise<void>((resolve, reject) => {
          mixCmd
            .on("end", () => {
              clearMergeFfmpegKill(mergeJobId);
              resolve();
            })
            .on("error", (_err: Error, _stdout: string, stderr: string) => {
              clearMergeFfmpegKill(mergeJobId);
              appendMergeLog(mergeJobId, `Audio mix lỗi: ${stderr?.slice(0, 500) || _err.message}`);
              reject(new Error(`Audio mix: ${stderr}`));
            })
            .save(outputPath);
        });
      } else {
        mergeThrowIfCancelled(mergeJobId);
        updateJob({ phase: "finalizing", progress: 90, current: "Finalizing output..." });
        appendMergeLog(mergeJobId, "Faststart (không nhạc nền)");
        const fastCmd = ffmpeg(intermediatePath).outputOptions(["-c copy", "-movflags +faststart"]);
        registerMergeFfmpegKill(mergeJobId, fastCmd);
        await new Promise<void>((resolve, reject) => {
          fastCmd
            .on("end", () => {
              clearMergeFfmpegKill(mergeJobId);
              resolve();
            })
            .on("error", (_err: Error, _stdout: string, stderr: string) => {
              clearMergeFfmpegKill(mergeJobId);
              appendMergeLog(mergeJobId, `Final lỗi: ${stderr?.slice(0, 500) || _err.message}`);
              reject(new Error(`Faststart: ${stderr}`));
            })
            .save(outputPath);
        });
      }

      const finalSizeMB = (fs.statSync(outputPath).size / 1048576).toFixed(1);
      appendMergeLog(mergeJobId, `Hoàn thành — ${finalSizeMB} MB`);
      console.log(`[Merge] ✅ Output: ${outputPath} (${finalSizeMB} MB)`);

      updateJob({
        status: "done",
        phase: "done",
        progress: 100,
        current: `Hoàn thành! ${finalSizeMB} MB`,
        downloadUrl: `/exports/${outputFilename}`,
      });
    } catch (error: any) {
      console.error(`[Merge] Job ${mergeJobId} failed:`, error);
      const msg = error?.message || String(error);
      appendMergeLog(mergeJobId, `THẤT BẠI: ${msg}`);
      const isCancel = msg.includes("MERGE_CANCELLED");
      updateJob({
        status: "error",
        phase: isCancel ? "cancelled" : "error",
        progress: 0,
        current: isCancel ? "Đã hủy bởi user" : msg,
        error: isCancel ? "MERGE_CANCELLED" : msg,
      });
    } finally {
      if (audioFile && fs.existsSync(audioFile.path)) {
        try { fs.unlinkSync(audioFile.path); } catch (_) {}
      }
      mergeRuntimeControls.delete(mergeJobId);
      setTimeout(() => fs.rm(tempDir, { recursive: true, force: true }, () => {}), 300_000);
    }
  })();
});

app.post("/api/projects/:projectId/merge-job/:mergeJobId/cancel", (req, res) => {
  const { mergeJobId } = req.params;
  const job = activeJobs.get(mergeJobId);
  if (!job) {
    return res.status(404).json({ error: "Merge job not found" });
  }
  if (job.status === "done" || job.status === "error") {
    return res.status(400).json({ error: "Job already finished" });
  }
  let rt = mergeRuntimeControls.get(mergeJobId);
  if (!rt) {
    rt = { cancelled: false };
    mergeRuntimeControls.set(mergeJobId, rt);
  }
  rt.cancelled = true;
  rt.killFfmpeg?.();
  appendMergeLog(mergeJobId, "User hủy merge");
  const cur = activeJobs.get(mergeJobId)!;
  activeJobs.set(mergeJobId, {
    ...cur,
    status: "error",
    phase: "cancelled",
    progress: 0,
    current: "Đã hủy bởi user",
    error: "MERGE_CANCELLED",
  });
  res.json({ ok: true });
});

app.get("/api/projects/:projectId/merge-job/:mergeJobId", (req, res) => {
  const { mergeJobId } = req.params;
  const job = activeJobs.get(mergeJobId);
  if (!job) {
    return res.status(404).json({ error: "Merge job not found" });
  }
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  return res.json({
    status: job.status === "done" ? "success" : job.status,
    phase: job.phase,
    progress: job.status === "done" ? 100 : (job.status === "error" ? 0 : (job.progress ?? 50)),
    current: job.current,
    mergedVideoUrl: job.downloadUrl,
    error: job.error,
    logs: job.logs ?? [],
    pollSeq: Date.now(),
  });
});

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;

  // Process termination handling to prevent zombie browsers
  const cleanup = async () => {
    console.log("Cleaning up resources before exit...");
    if (hqBrowser) await hqBrowser.close().catch(() => {});
    if ((global as any).storyBlocksBrowser) await (global as any).storyBlocksBrowser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Global 404 Handler for API routes - Move here to allow registered routes to match first
  app.use("/api/*", (req, res) => {
    res.status(404).json({ error: `API route ${req.originalUrl} not found` });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      root: process.cwd(),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In production
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  // Global Error Handler
  app.use(
    (
      err: any,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      console.error("Unhandled Error:", err);
      res.status(500).json({ error: err.message || "Internal Server Error" });
    },
  );

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
