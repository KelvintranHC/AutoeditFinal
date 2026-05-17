import { Copy, ExternalLink, Link2 } from "lucide-react";

export function resolveDriveFileIdForVideo(v: {
  driveFileId?: string;
  driveLink?: string;
}): string | null {
  const raw = v.driveFileId && String(v.driveFileId).trim();
  if (raw) return raw;
  const link = v.driveLink;
  if (!link || typeof link !== "string") return null;
  const m = link.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const m2 = link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return null;
}

export function resolveDriveDirectLink(v: {
  driveDirectLink?: string;
  driveFileId?: string;
  driveLink?: string;
}): string | null {
  if (v.driveDirectLink?.trim()) return v.driveDirectLink.trim();
  const id = resolveDriveFileIdForVideo(v);
  if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  return null;
}

export function DriveLinkActions({
  viewLink,
  directLink,
  compact = false,
}: {
  viewLink?: string;
  directLink?: string | null;
  compact?: boolean;
}) {
  const direct = directLink || (viewLink ? resolveDriveDirectLink({ driveLink: viewLink }) : null);
  if (!viewLink && !direct) return null;
  const copy = (url: string) => {
    navigator.clipboard.writeText(url).catch(() => {});
  };
  return (
    <div className={`flex flex-wrap items-center gap-1 ${compact ? "" : "gap-1.5"}`}>
      {viewLink && (
        <a
          href={viewLink}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 bg-emerald-100 hover:bg-emerald-200 text-emerald-800 px-2 py-0.5 rounded text-[8px] font-bold transition-colors"
        >
          <ExternalLink size={10} />
          VIEW DRIVE
        </a>
      )}
      {direct && (
        <>
          <a
            href={direct}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 bg-indigo-100 hover:bg-indigo-200 text-indigo-900 px-2 py-0.5 rounded text-[8px] font-bold transition-colors"
            title={direct}
          >
            <Link2 size={10} />
            DIRECT
          </a>
          <button
            type="button"
            onClick={() => copy(direct)}
            className="p-0.5 rounded hover:bg-[#1a1a1a]/10 text-[#4a4a40]"
            title="Copy direct link"
          >
            <Copy size={10} />
          </button>
        </>
      )}
    </div>
  );
}
