"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Package2 } from "lucide-react";
import type { DownloadDto, Page, UpdateHistoryDto } from "@updatepilot/contracts";
import { EmptyState, ErrorState, LoadingState } from "@/components/DataState";
import { DeviceSelector } from "@/components/DeviceSelector";
import { useDevice } from "@/components/DeviceProvider";
import { DownloadProgress } from "@/components/DownloadProgress";
import { PageIntro, Pagination, StatusPill } from "@/components/PageParts";
import { useLiveQuery } from "@/components/useLiveQuery";
import { formatDate } from "@/lib/format";

const active = new Set(["queued", "leased", "running", "verifying"]);
const stageLabel: Record<string, string> = {
  queued: "Waiting for update-enabled agent", leased: "Checking package evidence",
  running: "Running WinGet", verifying: "Verifying installed version",
  succeeded: "Installed version verified", failed: "Update failed",
  verification_failed: "Installed version not verified", cancelled: "Cancelled before execution",
  expired: "Queue wait expired", execution_unknown: "Execution uncertain — inspect installed version",
  action_required: "Action required", reboot_required: "Restart required; verification pending",
};

export default function DownloadsPage() {
  const { selectedDeviceId, selectedDevice } = useDevice();
  const [page, setPage] = useState(1);
  const downloadPath = selectedDeviceId
    ? `/update-history?page=${page}&deviceId=${selectedDeviceId}`
    : `/update-history?page=${page}`;
  const { data, error, loading, reload } = useLiveQuery<Page<UpdateHistoryDto>>(downloadPath);
  const items: DownloadDto[] = data?.items.map(job => {
    const last = job.events.at(-1);
    const progressStage = job.progressStage ?? (job.status === "running" &&
      (last?.status === "downloading" || last?.status === "installing") ? last.status : null);
    return { ...job, progressStage,
      downloadPercent: job.downloadPercent ?? (progressStage === "downloading" ? last?.downloadPercent ?? null : null),
      downloadedBytes: job.downloadedBytes ?? (progressStage === "downloading" ? last?.downloadedBytes ?? null : null),
      totalBytes: job.totalBytes ?? (progressStage === "downloading" ? last?.totalBytes ?? null : null) };
  }) ?? [];
  useEffect(() => {
    if (!data?.items.some(job => active.has(job.status))) return;
    const timer = window.setInterval(reload, 2000);
    return () => window.clearInterval(timer);
  }, [data, reload]);
  return <>
    <PageIntro
      eyebrow="Update jobs"
      title="Downloads"
      description={`Real WinGet jobs and recorded progress for ${selectedDevice ? selectedDevice.name : "your paired Windows devices"}. An update is complete only after its installed version is verified.`}
      trailing={
        <div className="flex flex-wrap items-center gap-2">
          <DeviceSelector />
          <button className="button-secondary" onClick={reload}>Refresh</button>
        </div>
      }
    />
    {loading && !data ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : data && data.items.length > 0 ? <div className="panel overflow-hidden"><ol>
      {items.map(job => <li key={job.id} className="border-b border-[#3d3d3d] p-4 last:border-0">
        <div className="flex items-start gap-3"><span className="desktop-app-icon"><Package2 className="h-5 w-5" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-2"><div><strong>{job.applicationName}</strong><p className="text-xs text-[#aaa]">{job.packageId} · {job.source} · {job.publisher ?? "Publisher unavailable"}</p></div><StatusPill status={job.status} /></div>
          <p className="mt-2 text-sm">{job.progressStage === "downloading" && job.status === "running" ? "Downloading" : job.progressStage === "installing" && job.status === "running" ? "Installing" : stageLabel[job.status] ?? job.status}</p>
          {job.status === "running" && job.progressStage === "downloading" ? <DownloadProgress applicationName={job.applicationName} percent={job.downloadPercent} downloadedBytes={job.downloadedBytes} totalBytes={job.totalBytes} /> : null}
          {job.status === "running" && job.progressStage !== "downloading" ? <p className="mt-1 text-xs text-[#aaa]">Installer progress is unavailable; waiting for WinGet result.</p> : null}
          <p className="mt-2 text-xs text-[#bbb]">Installed {job.installedVersion ?? "Unknown"} · Target {job.targetVersion}{job.observedVersion ? ` · Verified ${job.observedVersion}` : ""}</p>
          <p className="mt-1 text-xs text-[#999]">Queued {formatDate(job.createdAt)}{job.startedAt ? ` · Started ${formatDate(job.startedAt)}` : ""}{job.completedAt ? ` · Finished ${formatDate(job.completedAt)}` : ""}</p>
          {job.diagnosticCode ? <p className="mt-1 text-xs text-[#ff8a00]">{job.diagnosticCode}{job.exitCode != null ? ` · WinGet exit ${job.exitCode}` : ""}</p> : null}
          <Link className="mt-2 inline-block text-xs text-[#ff8a00] hover:underline" href={`/history/jobs/${encodeURIComponent(job.id)}`}>View in History</Link>
        </div></div>
      </li>)}</ol><Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} /></div> : <EmptyState title="No update jobs yet" description="Confirmed updates and their real WinGet progress will appear here. No downloads are started automatically." action={<Link className="button-secondary" href="/updates">Review available updates</Link>} />}
  </>;
}
