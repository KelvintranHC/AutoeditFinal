import React, { useState, useEffect } from "react";
import { X, Play, Loader2, CheckCircle2, XCircle, HardDrive, DownloadCloud } from "lucide-react";
import * as motion from "motion/react-client";

export function DownloaderModal({ onClose, projectId, scenes, config, onConnectDrive }: any) {
  const [jobs, setJobs] = useState<any[]>([]);

  // Collect selected videos
  const selectedVideos: any[] = [];
  scenes.forEach((scene: any) => {
    const sVids = scene.selectedVideos && scene.selectedVideos.length > 0 
      ? scene.selectedVideos 
      : [{ videoIdx: scene.selectedVideoIdx || 0 }];
    
    sVids.forEach((sv: any) => {
      const v = scene.videos[sv.videoIdx];
      if (v && v.stockUrl) {
         if (!selectedVideos.find(x => x.id === v.url)) {
             selectedVideos.push({
                id: v.url, // using preview url as unique id
                stockUrl: v.stockUrl,
                title: v.title
             });
         }
      }
    });
  });

  useEffect(() => {
    const eventSource = new EventSource(`/api/downloader/events/${projectId}`);
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.jobs) setJobs(data.jobs);
      } catch (e) {}
    };
    return () => eventSource.close();
  }, [projectId]);

  const startDownload = async (videosToDownload: any[]) => {
     try {
       await fetch("/api/downloader/start", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({
           projectId,
           videos: videosToDownload,
           cookies: config.storyblocksCookies,
           driveToken: config.driveAccessToken
         }),
       });
     } catch (e) {
       console.error(e);
     }
  };

  const startAll = () => startDownload(selectedVideos);
  const retryJob = (jobId: string) => {
     const v = selectedVideos.find(x => x.id === jobId);
     if (v) startDownload([v]);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[110] flex items-center justify-center p-4 text-slate-200 font-sans">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-4xl bg-[#0e0e11] border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10 bg-black/40">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <DownloadCloud className="text-indigo-400" size={20}/> Automation Downloader
            </h2>
            <p className="text-[11px] text-slate-400 mt-1 uppercase tracking-wider">
               Tải Video Gốc (Bản Đẹp) {config.driveAccessToken ? "& Lưu Tự Động Vào Google Drive" : ""}
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-white rounded-full hover:bg-white/10 transition">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
          {!config.storyblocksCookies && (
             <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-lg text-sm mb-4">
                Bạn chưa cấu hình Storyblocks Cookies. Vui lòng vào Settings để cấu hình trước khi tải.
             </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
             <div className="lg:col-span-1 border border-white/10 rounded-xl p-4 bg-black/20 flex flex-col gap-4">
                <h3 className="uppercase tracking-widest text-xs font-bold text-slate-500">Tùy Chọn Tải & Lưu</h3>
                
                <div className="bg-[#1a1a1f] p-3 rounded-lg border border-white/5 space-y-3">
                   <div className="flex items-center gap-2">
                      <HardDrive size={16} className={config.driveAccessToken ? "text-emerald-400" : "text-slate-400"} />
                      <span className="text-xs font-medium">{config.driveAccessToken ? "Đã kết nối Google Drive" : "Chưa kết nối Google Drive"}</span>
                   </div>
                   <button 
                     onClick={onConnectDrive}
                     className="w-full bg-[#2a2a35] hover:bg-[#323240] text-xs font-bold uppercase tracking-wider border border-white/10 px-3 py-2 rounded-lg transition-colors flex justify-center items-center gap-2"
                   >
                     {config.driveAccessToken ? "Cập Nhật Quyền Drive" : "Kết Nối Google Drive"}
                   </button>
                   <p className="text-[#888] text-[10px] leading-relaxed">
                     Hệ thống sẽ tải video bản gốc không che (watermark-free) bằng cách điều khiển trình duyệt ẩn danh. Video tải xong sẽ tự động được xoá trên server sau khi đẩy lên Drive.
                   </p>
                </div>

                <div className="mt-auto pt-4 border-t border-white/10">
                   <button
                     onClick={startAll}
                     disabled={!config.storyblocksCookies || selectedVideos.length === 0}
                     className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-bold uppercase text-xs tracking-wider px-4 py-3 rounded-xl shadow-[0_0_15px_rgba(79,70,229,0.3)] transition-all disabled:opacity-50 disabled:grayscale"
                   >
                      Tiến Hành Tải Toàn Bộ
                   </button>
                </div>
             </div>

             <div className="lg:col-span-2 space-y-2">
                <h3 className="uppercase tracking-widest text-xs font-bold text-slate-500 px-1">Danh Sách Video Trong Dự Án</h3>
                <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-2 custom-scrollbar">
                   {selectedVideos.map(v => {
                      const job = jobs.find(j => j.id === v.id);
                      let statusEl = <span className="text-[10px] uppercase font-bold text-slate-500">Waiting</span>;
                      if (job?.status === "downloading") statusEl = <span className="text-[10px] uppercase font-bold text-blue-400 flex items-center gap-1"><Loader2 size={10} className="animate-spin"/> Downloading</span>;
                      if (job?.status === "uploading") statusEl = <span className="text-[10px] uppercase font-bold text-amber-400 flex items-center gap-1"><Loader2 size={10} className="animate-spin"/> Uploading</span>;
                      if (job?.status === "success") statusEl = <span className="text-[10px] uppercase font-bold text-emerald-400 flex items-center gap-1"><CheckCircle2 size={10}/> Thành Công</span>;
                      if (job?.status === "error") statusEl = <span className="text-[10px] uppercase font-bold text-red-400 flex items-center gap-1" title={job?.error}><XCircle size={10}/> {job.error || "Thất bại"}</span>;

                      return (
                        <div key={v.id} className="flex items-center gap-3 bg-[#1a1a20] border border-white/5 p-2 rounded-lg">
                           <div className="w-16 h-9 bg-black rounded overflow-hidden relative group shrink-0">
                              <video src={v.id} className="w-full h-full object-cover" muted />
                           </div>
                           <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium truncate text-slate-200">{v.title}</p>
                              <p className="text-[10px] text-slate-500 truncate mt-0.5">{job?.driveLink ? <a href={job.driveLink} target="_blank" className="text-blue-400 hover:underline">Link GDrive</a> : v.stockUrl}</p>
                           </div>
                           <div className="shrink-0 w-28 flex justify-end">
                              {statusEl}
                           </div>
                           {(job?.status === "error" || job?.status === "success") && (
                              <button onClick={() => retryJob(v.id)} className="w-6 h-6 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md shrink-0">
                                <Play size={10} className="text-slate-300"/>
                              </button>
                           )}
                        </div>
                      )
                   })}
                   {selectedVideos.length === 0 && (
                      <div className="text-center py-10 text-slate-500 text-sm">Chưa có video nào được chọn</div>
                   )}
                </div>
             </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
