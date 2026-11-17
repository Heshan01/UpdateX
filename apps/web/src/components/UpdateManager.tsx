"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Package2 } from "lucide-react";
import type { ApplicationDto, DashboardDto, Page, UpdateJobDto, UpdatePreviewDto } from "@updatepilot/contracts";
import { useAuth } from "@/components/AuthProvider";
import { EmptyState, ErrorState, LoadingState } from "@/components/DataState";
import { DeviceSelector } from "@/components/DeviceSelector";
import { useDevice } from "@/components/DeviceProvider";
import { DownloadProgress } from "@/components/DownloadProgress";
import { PageIntro, Pagination, StatusPill } from "@/components/PageParts";
import { useLiveQuery } from "@/components/useLiveQuery";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";

const finished = new Set(["succeeded", "failed", "verification_failed", "reboot_required", "action_required", "cancelled", "expired", "execution_unknown"]);
type UpdateJobDetail = UpdateJobDto & { events?: { id: string; status: string; detail: string | null; createdAt: string }[] };
const jobMessage: Record<string, string> = {
  queued: "Waiting for the agent. No installation has started.",
  leased: "Agent claimed the job and is checking package evidence.",
  running: "WinGet is running. No result has been verified yet.",
  verifying: "WinGet exited; checking the installed version again.",
  succeeded: "The approved target version was observed after the update.",
  failed: "WinGet reported a failure. Review the diagnostic before retrying.",
  verification_failed: "The target version was not verified. Review the observed version and scan again.",
  execution_unknown: "Execution was interrupted or the agent disconnected. Check the installed version before any retry.",
  cancelled: "The queued job was cancelled before execution.",
  expired: "The queued job expired before the agent claimed it.",
  reboot_required: "A restart is required; success has not been verified.",
  action_required: "The agent stopped before execution because package evidence or permissions need attention.",
};

export function UpdateManager() {
  const { state } = useAuth();
  const { selectedDeviceId, selectedDevice } = useDevice();
  const [page, setPage] = useState(1);
  const updatesPath = selectedDeviceId
    ? `/updates?page=${page}&pageSize=20&deviceId=${selectedDeviceId}`
    : `/updates?page=${page}&pageSize=20`;
  const jobsPath = selectedDeviceId ? `/jobs?deviceId=${selectedDeviceId}` : "/jobs";
  const dashboardPath = selectedDeviceId ? `/dashboard?deviceId=${selectedDeviceId}` : "/dashboard";
  const windowsAppsPath = selectedDeviceId
    ? `/applications?installationType=windows_app&page=1&pageSize=5&deviceId=${selectedDeviceId}`
    : `/applications?installationType=windows_app&page=1&pageSize=5`;

  const { data, error, loading, reload } = useLiveQuery<Page<ApplicationDto>>(updatesPath);
  const { data: jobData, error: jobError, loading: jobsLoading, reload: reloadJobs } = useLiveQuery<{ items: UpdateJobDto[] }>(jobsPath);
  const { data: dashboard, reload: reloadDashboard } = useLiveQuery<DashboardDto>(dashboardPath);
  const { data: windowsApps, reload: reloadWindowsApps } = useLiveQuery<Page<ApplicationDto>>(windowsAppsPath);
  const [preview, setPreview] = useState<UpdatePreviewDto | null>(null);
  const [selected, setSelected] = useState<ApplicationDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [currentJob, setCurrentJob] = useState<UpdateJobDetail | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [desktopAgent, setDesktopAgent] = useState<DesktopAgentStatus | null>(null);
  const desktopAllowsQueue = !desktop || desktopAgent?.processState === "external_services" ||
    (desktopAgent?.managed && desktopAgent.deviceId === dashboard?.agent?.id &&
      desktopAgent.processState === "running" && desktopAgent.launchMode === "update_enabled");
  const scanStale = !!dashboard?.lastScanAt && Date.now() - Date.parse(dashboard.lastScanAt) > dashboard.scanReminderDays * 24 * 60 * 60_000;
  const canQueue = !scanStale && dashboard?.agent?.connection === "online" && dashboard.agent.executionMode === "update_enabled" && desktopAllowsQueue;

  useEffect(() => {
    const bridge = window.updatePilotDesktop;
    if (!bridge) return;
    setDesktop(true);
    let active = true;
    const refreshDesktop = () => { void bridge.getAgentStatus().then(status => { if (active) setDesktopAgent(status); }).catch(() => { if (active) setDesktopAgent(null); }); };
    refreshDesktop();
    const timer = window.setInterval(refreshDesktop, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => { const timer = window.setInterval(() => { reloadDashboard(); reloadJobs(); }, 10000); return () => window.clearInterval(timer); }, [reloadDashboard, reloadJobs]);

  useEffect(() => {
    if (!currentJob || finished.has(currentJob.status)) return;
    const timer = window.setInterval(() => {
      void api.get<UpdateJobDetail>("/jobs/" + currentJob.id).then(next => {
        setCurrentJob(next);
        reloadJobs();
        if (finished.has(next.status)) reload();
      }).catch(cause => setActionError(cause instanceof Error ? cause.message : "Could not refresh update progress."));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [currentJob, reloadJobs, reload]);

  function csrf(): string {
    if (!state?.csrfToken) throw new Error("Choose Guest or sign in to manage updates.");
    return state.csrfToken;
  }

  async function review(item: ApplicationDto) {
    setBusy(true); setActionError(null); setConfirmed(false); setSelected(null); setPreview(null);
    try {
      const value = await api.post<UpdatePreviewDto>("/applications/" + item.id + "/preview", {}, csrf());
      setSelected(item); setPreview(value);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not preview this update."); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!state?.csrfToken) return;
    const applicationId = new URLSearchParams(window.location.search).get("applicationId");
    if (!applicationId) return;
    window.history.replaceState(null, "", "/updates");
    void api.get<ApplicationDto>("/applications/" + encodeURIComponent(applicationId))
      .then(item => review(item))
      .catch(cause => setActionError(cause instanceof Error ? cause.message : "Could not open that application's preview."));
    // The query parameter is consumed once; it never queues an update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.csrfToken]);

  async function queueUpdate() {
    if (!preview || !confirmed || !canQueue) return;
    setBusy(true); setActionError(null);
    try {
      const job = await api.post<UpdateJobDto>("/updates/execute", {
        previewId: preview.id, confirmation: true, idempotencyKey: window.crypto.randomUUID(),
      }, csrf());
      setCurrentJob(job); setPreview(null); setSelected(null); setConfirmed(false); reloadJobs();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not queue this update."); }
    finally { setBusy(false); }
  }

  async function cancelJob(job: UpdateJobDto) {
    setBusy(true); setActionError(null);
    try {
      const cancelled = await api.post<UpdateJobDto>("/jobs/" + job.id + "/cancel", {}, csrf());
      if (currentJob?.id === job.id) setCurrentJob(cancelled);
      reloadJobs();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not cancel this job."); }
    finally { setBusy(false); }
  }

  async function viewJob(job: UpdateJobDto) {
    setActionError(null);
    try { setCurrentJob(await api.get<UpdateJobDetail>("/jobs/" + job.id)); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not load this job."); }
  }

  function refresh() { reload(); reloadJobs(); reloadDashboard(); reloadWindowsApps(); }

  return <>
    <PageIntro
      eyebrow="Verified opportunities"
      title="Available updates"
      description={`Only trusted WinGet matches for ${selectedDevice ? selectedDevice.name : "your paired Windows device"} are eligible. Review the exact package and version before creating a job.`}
      trailing={
        <div className="flex flex-wrap items-center gap-2">
          <DeviceSelector />
          <button className="button-secondary" onClick={refresh}>Refresh</button>
        </div>
      }
    />
    {actionError && <p className="desktop-update-error" role="alert">{actionError}</p>}
    {currentJob && <div className="desktop-current-job" role="status"><div><strong>Update job: {currentJob.status.replaceAll("_", " ")}</strong><p>{currentJob.packageId} · {currentJob.installedVersion ?? "Unknown"} → {currentJob.targetVersion}{currentJob.observedVersion ? " · observed " + currentJob.observedVersion : ""}{currentJob.diagnosticCode ? " · " + currentJob.diagnosticCode : ""}</p><p>{jobMessage[currentJob.status] ?? "Check the agent and job history for details."}</p>{currentJob.status === "running" && currentJob.progressStage === "downloading" && <DownloadProgress applicationName={currentJob.packageId} percent={currentJob.downloadPercent} downloadedBytes={currentJob.downloadedBytes} totalBytes={currentJob.totalBytes} />}{currentJob.events?.length ? <ol aria-label="Job events">{currentJob.events.map(event => <li key={event.id}>{formatDate(event.createdAt)} · {event.status.replaceAll("_", " ")}{event.detail ? " · " + event.detail : ""}</li>)}</ol> : null}</div><StatusPill status={currentJob.status} /></div>}
    <p className="desktop-update-notice" role="status">{scanStale ? "Saved update evidence is older than your scan preference. Run a fresh scan before reviewing or queuing an update." : !dashboard?.agent ? "No paired agent is available. Saved update opportunities are for review only." : dashboard.agent.connection !== "online" ? "Agent offline. Saved update opportunities may be stale; no update can be queued." : dashboard.agent.executionMode === "read_only" ? "Agent online in read-only mode. You may review an exact update, but no installation job can be queued." : !desktopAllowsQueue ? "The desktop-managed agent has not confirmed update-enabled mode. Check its status in Settings." : "Agent reports update-enabled mode. An exact preview and explicit confirmation are required before a job can be queued."}{dashboard?.lastScanAt ? " Last successful scan: " + formatDate(dashboard.lastScanAt) + "." : ""}</p>
    {desktop && dashboard?.agent?.executionMode === "read_only" && <p className="mb-4 text-sm">An older read-only agent is still running. Close that agent, then <Link className="font-semibold text-[#ff8a00] underline" href="/settings">restart the agent in Settings</Link>.</p>}
    {loading && !data ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : data && data.items.length ? <div className="panel overflow-hidden">
      <div className="desktop-list-heading"><h2>Updates available</h2><span>{data.total} verified opportunities</span></div>
      <div className="desktop-list-rows">{data.items.map(item => <div className="desktop-app-row desktop-update-row" key={item.id}>
        <span className="desktop-app-icon" aria-hidden="true"><Package2 className="h-5 w-5" /></span>
        <div className="desktop-app-main"><span className="desktop-app-name">{item.displayName}</span><span className="desktop-app-meta">{item.publisher ?? "Publisher unknown"}</span><span className="desktop-app-package" title={item.packageId ?? undefined}>{item.packageId}</span></div>
        <div className="desktop-app-versions"><span>Installed <strong>{item.installedVersion ?? "Unknown"}</strong></span><span>Available <strong className="version-available">{item.availableVersion ?? "Unknown"}</strong></span></div>
        <div className="desktop-app-right"><StatusPill status={item.updateStatus} /><button className="desktop-row-action" disabled={busy || scanStale} onClick={() => void review(item)} aria-label={"Review update for " + item.displayName}>Review <ArrowUpRight className="h-3.5 w-3.5" /></button></div>
      </div>)}</div>
      <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} />
    </div> : <EmptyState title="No verified updates to show" description="Run a Windows scan. Unknown, ambiguous, and unsupported packages remain visible in Applications with their reasons." />}
    <section className="panel mt-5 p-4" aria-labelledby="windows-apps-heading"><h2 id="windows-apps-heading" className="font-semibold">Windows apps and Microsoft Store</h2><p className="mt-1 text-sm text-[#bdbdbd]">{windowsApps ? `${windowsApps.total} installed Windows apps in the saved scan.` : "Checking the saved Windows app inventory."} UpdateX cannot verify Store update availability or control Store downloads. Check in Microsoft Store, then rescan to confirm the installed version.</p><div className="mt-3 flex flex-wrap gap-2"><button className="button-secondary" onClick={() => { if (window.updatePilotDesktop) void window.updatePilotDesktop.openMicrosoftStore().catch(() => window.alert("Microsoft Store could not be opened on this Windows installation.")); else window.location.href = "ms-windows-store://downloadsandupdates"; }}>Check in Microsoft Store</button><Link className="button-secondary" href="/applications">Open Applications and select Windows apps</Link></div></section>
    <section className="desktop-jobs" aria-labelledby="recent-jobs"><h2 id="recent-jobs">Recent update jobs</h2>{jobsLoading && !jobData ? <LoadingState /> : jobError ? <ErrorState message={jobError} retry={reloadJobs} /> : jobData?.items.length ? <div className="panel">{jobData.items.map(job => <div className="desktop-job-row" key={job.id}><div><strong>{job.packageId}</strong><span>{job.installedVersion ?? "Unknown"} → {job.targetVersion}{job.observedVersion ? " · observed " + job.observedVersion : ""}</span><small>Requested {formatDate(job.createdAt)}{job.diagnosticCode ? " · " + job.diagnosticCode : ""}{job.status === "queued" ? " · Waiting for agent; no installation has started." : ""}</small></div><div className="flex items-center gap-2"><StatusPill status={job.status} /><button className="button-secondary" onClick={() => void viewJob(job)} aria-label={"View job details for " + job.packageId}>Details</button>{job.status === "queued" && <button className="button-secondary" disabled={busy} onClick={() => void cancelJob(job)}>Cancel queued job</button>}</div></div>)}</div> : <p>No update jobs have been requested.</p>}</section>
    {preview && selected && <div className="desktop-modal-backdrop" role="presentation"><div className="desktop-preview panel" role="dialog" aria-modal="true" aria-labelledby="preview-title">
      <p className="desktop-eyebrow">Exact update preview</p><h2 id="preview-title">{selected.displayName}</h2>
      <dl><div><dt>Publisher</dt><dd>{preview.publisher}</dd></div><div><dt>WinGet package</dt><dd className="break-all font-mono">{preview.packageId}</dd></div><div><dt>Installed</dt><dd>{preview.installedVersion}</dd></div><div><dt>Target</dt><dd>{preview.targetVersion}</dd></div></dl>
      <ul>{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      <label className="desktop-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I confirm this exact package and target version may be queued for update.</span></label>
      {!canQueue && <p role="status" className="desktop-update-notice">The paired agent and, in the desktop app, its managed process must report update-enabled mode before a job can be queued. Review is read-only.</p>}
      <div className="desktop-preview-actions"><button className="button-secondary" disabled={busy} onClick={() => { setPreview(null); setSelected(null); setConfirmed(false); }}>Cancel</button><button className="button-primary" disabled={!confirmed || !canQueue || busy || new Date(preview.expiresAt) <= new Date()} onClick={() => void queueUpdate()}>{busy ? "Queuing…" : "Confirm and queue"}</button></div>
    </div></div>}
  </>;
}
