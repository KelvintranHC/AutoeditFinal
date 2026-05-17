import React, { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Coins,
  Cpu,
  Settings2,
  Trash2,
} from "lucide-react";
import {
  DEFAULT_USD_TO_VND,
  summarizeTokenUsageLog,
  type ProjectTokenUsageLog,
  type TokenUsageAttempt,
  type TokenUsageSettings,
  type TokenUsageStepRecord,
} from "../lib/tokenUsage";

function formatVnd(n: number): string {
  return `${Math.round(n).toLocaleString("vi-VN")} ₫`;
}

function formatUsd(n: number): string {
  return `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(3)}`;
}

function formatDt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusBadge(status: TokenUsageAttempt["status"]) {
  const cls =
    status === "success"
      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
      : status === "failed"
        ? "bg-red-500/15 text-red-400 border-red-500/30"
        : "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return (
    <span
      className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded border ${cls}`}
    >
      {status}
    </span>
  );
}

function AttemptDetail({ attempt }: { attempt: TokenUsageAttempt }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-white/5 rounded-lg bg-black/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-white/5"
      >
        <span className="text-[10px] text-slate-400 font-mono">
          Lần #{attempt.attemptIndex} · {formatDt(attempt.startedAt)} ·{" "}
          {attempt.durationMs}ms
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {statusBadge(attempt.status)}
          {open ? (
            <ChevronDown size={12} className="text-slate-500" />
          ) : (
            <ChevronRight size={12} className="text-slate-500" />
          )}
        </span>
      </button>
      {open ? (
        <div className="px-3 pb-3 space-y-2 text-[10px] border-t border-white/5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2">
            <div>
              <span className="text-slate-500 block">Model</span>
              <span className="text-slate-200 font-mono">{attempt.model}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Input</span>
              <span className="text-slate-200">
                {attempt.inputTokens.toLocaleString()}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Output</span>
              <span className="text-slate-200">
                {attempt.outputTokens.toLocaleString()}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Chi phí</span>
              <span className="text-amber-300">
                {formatUsd(attempt.costUsd)} · {formatVnd(attempt.costVnd)}
              </span>
            </div>
          </div>
          {attempt.error ? (
            <p className="text-red-400 bg-red-500/10 rounded p-2">{attempt.error}</p>
          ) : null}
          {attempt.promptPreview ? (
            <div>
              <span className="text-slate-500 font-bold uppercase text-[9px]">
                Prompt / input
              </span>
              <pre className="mt-1 p-2 rounded bg-black/50 text-slate-300 whitespace-pre-wrap max-h-40 overflow-y-auto custom-scrollbar text-[9px]">
                {attempt.promptPreview}
              </pre>
            </div>
          ) : null}
          {attempt.outputPreview ? (
            <div>
              <span className="text-slate-500 font-bold uppercase text-[9px]">
                Output
              </span>
              <pre className="mt-1 p-2 rounded bg-black/50 text-slate-300 whitespace-pre-wrap max-h-40 overflow-y-auto custom-scrollbar text-[9px]">
                {attempt.outputPreview}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StepRow({ step }: { step: TokenUsageStepRecord }) {
  const [open, setOpen] = useState(true);
  const totals = step.attempts.reduce(
    (acc, a) => {
      acc.tokens += a.totalTokens;
      acc.usd += a.costUsd;
      acc.vnd += a.costVnd;
      return acc;
    },
    { tokens: 0, usd: 0, vnd: 0 },
  );

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-white/5 text-left"
      >
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-200">{step.stepLabel}</p>
          <p className="text-[9px] text-slate-500 mt-0.5">
            {step.attempts.length} lần gọi ·{" "}
            {totals.tokens.toLocaleString()} tokens
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs font-bold text-amber-300">{formatVnd(totals.vnd)}</p>
          <p className="text-[9px] text-slate-500">{formatUsd(totals.usd)}</p>
        </div>
      </button>
      {open ? (
        <div className="px-3 pb-3 space-y-2 border-t border-white/5">
          {step.attempts.map((a) => (
            <div key={a.id}>
              <AttemptDetail attempt={a} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface TokenUsagePanelProps {
  projectTitle?: string;
  log: ProjectTokenUsageLog;
  settings: TokenUsageSettings;
  onSettingsChange: (next: TokenUsageSettings) => void;
  onSaveSettings: () => void;
  onClearLog?: () => void;
}

export function TokenUsagePanel({
  projectTitle,
  log,
  settings,
  onSettingsChange,
  onSaveSettings,
  onClearLog,
}: TokenUsagePanelProps) {
  const summary = useMemo(() => summarizeTokenUsageLog(log), [log]);
  const [showSettings, setShowSettings] = useState(false);
  const [pricingJson, setPricingJson] = useState(() =>
    JSON.stringify(settings.modelPricing, null, 2),
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#0a0a0c]">
      <div className="p-4 md:p-6 border-b border-white/10 bg-black/30 shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Coins size={16} className="text-amber-400" />
              Token Usage
            </h2>
            <p className="text-[10px] text-slate-500 mt-1">
              {projectTitle
                ? `Dự án: ${projectTitle}`
                : "Chọn một dự án để xem chi phí token"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowSettings(!showSettings)}
              className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-lg border border-white/10 text-slate-400 hover:text-white flex items-center gap-1.5"
            >
              <Settings2 size={12} />
              Cấu hình giá
            </button>
            {onClearLog ? (
              <button
                type="button"
                onClick={onClearLog}
                className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 flex items-center gap-1.5"
              >
                <Trash2 size={12} />
                Xóa log
              </button>
            ) : null}
          </div>
        </div>

        {showSettings ? (
          <div className="mt-4 p-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 space-y-3">
            <label className="flex flex-col gap-1 text-[10px] text-slate-400">
              Tỷ giá USD → VNĐ
              <input
                type="number"
                min={1}
                value={settings.usdToVndRate}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    usdToVndRate: Math.max(1, Number(e.target.value) || DEFAULT_USD_TO_VND),
                  })
                }
                className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-slate-200 text-sm max-w-xs"
              />
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-[10px] text-slate-400">
              <input
                type="checkbox"
                checked={settings.storePromptDetails}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    storePromptDetails: e.target.checked,
                  })
                }
                className="rounded border-white/20"
              />
              Lưu prompt/output chi tiết (tốn dung lượng project)
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-slate-400">
              Bảng giá model (JSON: USD / 1M tokens — inputPer1M, outputPer1M)
              <textarea
                value={pricingJson}
                onChange={(e) => setPricingJson(e.target.value)}
                onBlur={() => {
                  try {
                    const p = JSON.parse(pricingJson) as Record<
                      string,
                      { inputPer1M: number; outputPer1M: number }
                    >;
                    onSettingsChange({ ...settings, modelPricing: p });
                  } catch {
                    setPricingJson(JSON.stringify(settings.modelPricing, null, 2));
                  }
                }}
                rows={6}
                className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-slate-200 font-mono text-[10px] custom-scrollbar"
              />
            </label>
            <button
              type="button"
              onClick={onSaveSettings}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-[10px] font-bold uppercase text-white hover:bg-indigo-500"
            >
              Lưu cấu hình token
            </button>
          </div>
        ) : null}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          <div className="p-3 rounded-xl bg-white/5 border border-white/10">
            <span className="text-[9px] uppercase text-slate-500 font-bold">
              Tổng token
            </span>
            <p className="text-lg font-bold text-indigo-300 mt-1">
              {summary.totalTokens.toLocaleString()}
            </p>
            <p className="text-[9px] text-slate-600">
              in {summary.totalInputTokens.toLocaleString()} · out{" "}
              {summary.totalOutputTokens.toLocaleString()}
            </p>
          </div>
          <div className="p-3 rounded-xl bg-white/5 border border-white/10">
            <span className="text-[9px] uppercase text-slate-500 font-bold">
              Chi phí VNĐ
            </span>
            <p className="text-lg font-bold text-amber-300 mt-1">
              {formatVnd(summary.totalCostVnd)}
            </p>
            <p className="text-[9px] text-slate-600">
              ≈ {formatUsd(summary.totalCostUsd)} USD
            </p>
          </div>
          <div className="p-3 rounded-xl bg-white/5 border border-white/10">
            <span className="text-[9px] uppercase text-slate-500 font-bold">
              Model tốn nhất
            </span>
            <p className="text-xs font-mono text-slate-200 mt-1 truncate">
              {summary.topModelByTokens || "—"}
            </p>
          </div>
          <div className="p-3 rounded-xl bg-white/5 border border-white/10">
            <span className="text-[9px] uppercase text-slate-500 font-bold">
              Bước tốn nhất
            </span>
            <p className="text-xs text-slate-200 mt-1 truncate">
              {summary.topStepByCost?.stepLabel || "—"}
            </p>
            {summary.topStepByCost ? (
              <p className="text-[9px] text-amber-400">
                {formatVnd(summary.topStepByCost.costVnd)}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar">
        {log.steps.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-600 opacity-50 gap-3">
            <Cpu size={40} strokeWidth={1} />
            <p className="text-sm font-mono tracking-widest">CHƯA CÓ DỮ LIỆU TOKEN</p>
            <p className="text-[10px] text-center max-w-sm">
              Chạy transcribe MP3, phân tích SRT hoặc các bước AI khác — mỗi lần gọi
              (kể cả retry) sẽ hiển thị tại đây.
            </p>
          </div>
        ) : (
          <div className="space-y-6 max-w-4xl mx-auto">
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3">
                Theo bước xử lý
              </h3>
              <div className="space-y-3">
                {log.steps.map((s) => (
                  <div key={s.stepId}>
                    <StepRow step={s} />
                  </div>
                ))}
              </div>
            </section>

            {summary.byModel.length > 0 ? (
              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3">
                  Theo model
                </h3>
                <div className="overflow-x-auto rounded-xl border border-white/10">
                  <table className="w-full text-[10px]">
                    <thead className="bg-white/5 text-slate-500 uppercase">
                      <tr>
                        <th className="text-left px-3 py-2">Model</th>
                        <th className="text-right px-3 py-2">Tokens</th>
                        <th className="text-right px-3 py-2">USD</th>
                        <th className="text-right px-3 py-2">VNĐ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byModel.map((m) => (
                        <tr
                          key={m.model}
                          className="border-t border-white/5 text-slate-300"
                        >
                          <td className="px-3 py-2 font-mono">{m.model}</td>
                          <td className="px-3 py-2 text-right">
                            {m.totalTokens.toLocaleString()}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatUsd(m.costUsd)}
                          </td>
                          <td className="px-3 py-2 text-right text-amber-300">
                            {formatVnd(m.costVnd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
