const STORAGE_KEY = "autoedit-app-session";

export interface AppSession {
  token: string;
  username: string;
}

export function loadAppSession(): AppSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppSession;
    if (!parsed?.token || !parsed?.username) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveAppSession(session: AppSession) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearAppSession() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export async function verifyAppSession(token: string): Promise<boolean> {
  const res = await fetch("/api/auth/app-verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ token }),
    cache: "no-store",
  });
  return res.ok;
}

export async function loginApp(
  username: string,
  password: string,
): Promise<AppSession> {
  const res = await fetch("/api/auth/app-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { error?: string })?.error || "Đăng nhập thất bại",
    );
  }
  const session: AppSession = {
    token: (data as { token: string }).token,
    username: (data as { username: string }).username,
  };
  saveAppSession(session);
  return session;
}
