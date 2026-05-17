import React, { useState } from "react";
import { Loader2, Lock, MonitorPlay, User } from "lucide-react";
import { getAppUpdateLabel, getAppVersionTitle } from "../appInfo";

interface AppLoginScreenProps {
  onSuccess: () => void;
  onLogin: (username: string, password: string) => Promise<void>;
}

export function AppLoginScreen({ onSuccess, onLogin }: AppLoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onLogin(username.trim(), password);
      onSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Đăng nhập thất bại");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#050505] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0c0c0f] shadow-2xl shadow-indigo-950/40 overflow-hidden">
        <div className="p-6 border-b border-white/10 bg-gradient-to-r from-indigo-950/50 to-transparent">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <MonitorPlay className="text-white" size={22} />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white">
                {getAppVersionTitle().replace("_", " ")}
              </h1>
              <p className="text-[10px] text-slate-500 font-mono">
                {getAppUpdateLabel()}
              </p>
            </div>
          </div>
          <p className="text-sm text-slate-400 mt-4">
            Đăng nhập để sử dụng phần mềm
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="space-y-2">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Tên đăng nhập
            </label>
            <div className="relative">
              <User
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full pl-10 pr-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/50"
                placeholder="Admin"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Mật khẩu
            </label>
            <div className="relative">
              <Lock
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-10 pr-3 py-2.5 rounded-lg bg-black/40 border border-white/10 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/50"
                placeholder="••••••••"
                required
              />
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Đang đăng nhập...
              </>
            ) : (
              "Đăng nhập"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
