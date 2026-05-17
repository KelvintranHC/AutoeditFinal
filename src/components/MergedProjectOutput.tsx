import {
  CheckCircle2,
  Download,
  ExternalLink,
  HardDrive,
  Loader2,
} from "lucide-react";
import { DriveLinkActions } from "./driveLinkActions";

export type MergedProjectOutputProps = {
  variant: "banner" | "panel";
  mergedVideoUrl: string;
  mergeUploadBusy: boolean;
  canUploadDrive: boolean;
  mergeUploadedDriveUrl: string | null;
  mergeUploadedDriveDirectUrl: string | null;
  onDownload: () => void;
  onUploadDrive: () => void;
};

/** UI merge final — chỉ render khi project đã có bản merge (caller kiểm soát). */
export function MergedProjectOutput({
  variant,
  mergedVideoUrl,
  mergeUploadBusy,
  canUploadDrive,
  mergeUploadedDriveUrl,
  mergeUploadedDriveDirectUrl,
  onDownload,
  onUploadDrive,
}: MergedProjectOutputProps) {
  if (variant === "banner") {
    return (
      <div className="bg-emerald-600 text-white px-4 py-2.5 text-[10px] font-bold uppercase flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        <CheckCircle2 size={12} className="shrink-0" />
        <span className="shrink-0 normal-case font-medium">
          Merge xong — tải / đẩy Drive bất cứ lúc nào
        </span>
        <button
          type="button"
          onClick={onDownload}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-emerald-800/90 hover:bg-emerald-900 text-[9px] font-bold uppercase border border-white/20"
        >
          <Download size={10} /> Tải về máy
        </button>
        <a
          href={mergedVideoUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-white/20 hover:bg-white/30 text-[9px] font-bold uppercase"
        >
          <ExternalLink size={10} /> Mở trên server
        </a>
        <button
          type="button"
          disabled={mergeUploadBusy || !canUploadDrive}
          onClick={onUploadDrive}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-amber-400 hover:bg-amber-300 text-[#1a1a1a] text-[9px] font-bold uppercase disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {mergeUploadBusy ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <HardDrive size={10} />
          )}
          {mergeUploadBusy ? "Đang upload…" : "Lên Drive"}
        </button>
        {mergeUploadedDriveUrl && (
          <span className="inline-flex items-center gap-1 [&_a]:text-white [&_a]:bg-white/15 [&_a]:hover:bg-white/25 [&_button]:text-white">
            <DriveLinkActions
              viewLink={mergeUploadedDriveUrl}
              directLink={mergeUploadedDriveDirectUrl}
              compact
            />
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mb-6 p-4 rounded-lg border-2 border-emerald-600/25 bg-emerald-50/80 space-y-3">
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-emerald-800">
        <CheckCircle2 size={16} className="shrink-0" />
        Video final đã merge
      </div>
      <p className="text-[11px] text-[#4a4a40] normal-case leading-relaxed">
        Queue và thao tác từng clip vẫn dùng được. Bạn có thể tải bản merge, mở trên
        server, hoặc đẩy lên Drive bất cứ lúc nào.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onDownload}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1a1a1a] text-white text-[9px] font-bold uppercase hover:bg-[#333]"
        >
          <Download size={11} /> Tải về máy
        </button>
        <a
          href={mergedVideoUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#b8b8b0] bg-white text-[9px] font-bold uppercase text-[#1a1a1a] hover:bg-[#f0f0ec]"
        >
          <ExternalLink size={11} /> Mở trên server
        </a>
        <button
          type="button"
          disabled={mergeUploadBusy || !canUploadDrive}
          onClick={onUploadDrive}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-indigo-600 text-white text-[9px] font-bold uppercase hover:bg-indigo-700 disabled:opacity-50"
        >
          {mergeUploadBusy ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <HardDrive size={11} />
          )}
          Lên Drive
        </button>
        {mergeUploadedDriveUrl && (
          <DriveLinkActions
            viewLink={mergeUploadedDriveUrl}
            directLink={mergeUploadedDriveDirectUrl}
          />
        )}
      </div>
    </div>
  );
}
