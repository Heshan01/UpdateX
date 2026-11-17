"use client";

import { useState } from "react";
import { Clock3 } from "lucide-react";
import type { HistoryItemDto, Page, UpdateHistoryDto } from "@updatepilot/contracts";
import { EmptyState, ErrorState, LoadingState } from "@/components/DataState";
import { DeviceSelector } from "@/components/DeviceSelector";
import { useDevice } from "@/components/DeviceProvider";
import { PageIntro, Pagination, StatusPill } from "@/components/PageParts";
import { useLiveQuery } from "@/components/useLiveQuery";
import { downloadCsv } from "@/lib/download";
import { formatDate } from "@/lib/format";

const statusExplanation: Record<string, string> = {
  queued: "Waiting for the agent; installation has not started.",
  leased: "Agent claimed the job and is checking the exact package.",
  running: "Installation is in progress; no result is verified yet.",
  verifying: "Installer exited; the agent is checking the installed version.",
  succeeded: "The target version was observed after installation.",
  failed: "The installer reported a failure. See diagnostic and progress details.",
  verification_failed: "The target version was not observed after installation.",
  cancelled: "The job was cancelled before execution.",
  expired: "The agent did not claim the job before it expired.",
  execution_unknown: "Execution was interrupted. Inspect the installed version before any retry.",
  action_required: "The agent stopped because package evidence or permissions need attention.",
  reboot_required: "A restart is required; success has not been verified.",
};

export default function HistoryPage() {
  const { selectedDeviceId, selectedDevice } = useDevice();
  const [page, setPage] = useState(1);
  const [eventPage, setEventPage] = useState(1);
  const [exportError, setExportError] = useState<string | null>(null);
  const updatesPath = selectedDeviceId ? `/update-history?page=${page}&pageSize=20&deviceId=${selectedDeviceId}` : `/update-history?page=${page}&pageSize=20`;
  const updates = useLiveQuery<Page<UpdateHistoryDto>>(updatesPath);
  const activity = useLiveQuery<Page<HistoryItemDto>>(`/history?page=${eventPage}&pageSize=20`);

  const handleExport = () => {
    const exportPath = selectedDeviceId ? `/update-history/export.csv?deviceId=${selectedDeviceId}` : "/update-history/export.csv";
    const filename = selectedDevice ? `updatex-${selectedDevice.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}-history.csv` : "updatex-update-history.csv";
    void downloadCsv(exportPath, filename).catch(cause => setExportError(cause instanceof Error ? cause.message : "Export failed."));
  };

  return <>
    <PageIntro
      eyebrow="Audit trail"
      title="History"
      description={`Saved update jobs and account activity for ${selectedDevice ? selectedDevice.name : "your paired Windows devices"}. An update is successful only after its installed version is verified.`}
      trailing={
        <div className="flex flex-wrap items-center gap-2">
          <DeviceSelector />
          <button className="button-secondary" onClick={handleExport}>Export update history</button>
          <button className="button-secondary" onClick={() => { updates.reload(); activity.reload(); }}>Refresh</button>
        </div>
      }
    />
    {exportError && <p className="desktop-update-error" role="alert">{exportError}</p>}
    <section aria-labelledby="update-history-heading"><h2 id="update-history-heading" className="mb-3 text-lg font-semibold">Update jobs</h2>
      {updates.loading && !updates.data ? <LoadingState /> : updates.error ? <ErrorState message={updates.error} retry={updates.reload} /> : updates.data && updates.data.items.length > 0 ? <div className="panel overflow-hidden"><ol>{updates.data.items.map(job => <li key={job.id} className="border-b border-[#3d3d3d] p-4 last:border-0"><div className="flex flex-wrap items-start justify-between gap-3"><div><strong>{job.applicationName}</strong><p className="text-xs text-[#bdbdbd]">{job.packageId} · {job.publisher ?? "Publisher unavailable"}</p></div><StatusPill status={job.status} /></div><p className="mt-2 text-sm text-[#bdbdbd]">{statusExplanation[job.status] ?? "Review the job events for the current state."}</p><dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3"><div><dt className="text-[#999]">Before</dt><dd>{job.installedVersion ?? "Unknown"}</dd></div><div><dt className="text-[#999]">Target</dt><dd>{job.targetVersion}</dd></div><div><dt className="text-[#999]">Verified installed</dt><dd>{job.observedVersion ?? "Not verified"}</dd></div></dl><p className="mt-3 text-xs text-[#bdbdbd]">Requested {formatDate(job.createdAt)}{job.startedAt ? ` · Started ${formatDate(job.startedAt)}` : " · Not started"}{job.completedAt ? ` · Finished ${formatDate(job.completedAt)}` : ""}</p>{job.diagnosticCode && <p className="mt-1 text-xs text-[#ff8a00]">Diagnostic: {job.diagnosticCode}{job.exitCode != null ? ` · WinGet exit code ${job.exitCode}` : ""}</p>}{job.events.length > 0 && <details className="mt-2 text-xs"><summary className="cursor-pointer text-[#ff8a00]">Progress and details</summary><ol className="mt-2 space-y-1">{job.events.map(event => <li key={event.id}>{formatDate(event.createdAt)} · {event.status.replaceAll("_", " ")}{event.detail ? ` · ${event.detail}` : ""}</li>)}</ol></details>}</li>)}</ol><Pagination page={updates.data.page} totalPages={updates.data.totalPages} total={updates.data.total} onPage={setPage} /></div> : <EmptyState title="No update jobs yet" description="Confirmed update jobs will appear here, including pending, failed, cancelled, and verified results." />}
    </section>
    <section className="mt-8" aria-labelledby="activity-heading"><h2 id="activity-heading" className="mb-3 text-lg font-semibold">Scan and account activity</h2>
      {activity.loading && !activity.data ? <LoadingState /> : activity.error ? <ErrorState message={activity.error} retry={activity.reload} /> : activity.data && activity.data.items.length > 0 ? <div className="panel overflow-hidden"><ol>{activity.data.items.map(item => <li key={item.id} className="desktop-history-row"><span className="desktop-app-icon"><Clock3 className="h-4 w-4" /></span><div><strong>{item.title}</strong><p>{item.detail ?? item.kind}</p></div><div className="desktop-history-tail"><StatusPill status={item.status} /><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></div></li>)}</ol><Pagination page={activity.data.page} totalPages={activity.data.totalPages} total={activity.data.total} onPage={setEventPage} /></div> : <EmptyState title="No activity yet" description="Account and scan events will appear here." />}
    </section>
  </>;
}
