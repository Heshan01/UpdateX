"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, LoaderCircle, RotateCw, ScanSearch, WifiOff } from "lucide-react";
import type { DashboardDto, ScanJobDto } from "@updatepilot/contracts";
import { useAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";

const active = new Set(["queued", "running"]);
const activeKey = "updatepilot.active-scan-id";

export function ScanCenter({ dashboard, onCompleted }: { dashboard: DashboardDto; onCompleted: () => void }) {
  const { state } = useAuth();
  const [scan, setScan] = useState<ScanJobDto | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = dashboard.agent;
  const agentId = agent?.id;
  const online = agent?.connection === "online";

  useEffect(() => {
    setScan(null);
    setError(null);
    const id = window.sessionStorage.getItem(activeKey);
    const path = id ? "/scans/" + id : agentId ? "/devices/" + agentId + "/scans/latest" : null;
    if (!path) return;
    void api.get<ScanJobDto | null>(path).then(setScan).catch(() => {
      if (id) window.sessionStorage.removeItem(activeKey);
      setError("The previous scan status could not be recovered. Saved inventory remains available.");
    });
  }, [agentId]);

  const refreshScan = useCallback(async (id: string) => {
    try {
      const next = await api.get<ScanJobDto>("/scans/" + id);
      setScan(next);
      setError(null);
      if (!active.has(next.status)) onCompleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh the scan status.");
    }
  }, [onCompleted]);

  useEffect(() => {
    if (!scan || !active.has(scan.status)) return;
    const timer = window.setInterval(() => { void refreshScan(scan.id); }, 3000);
    return () => window.clearInterval(timer);
  }, [scan, refreshScan]);

  useEffect(() => {
    if (scan && !active.has(scan.status)) window.sessionStorage.removeItem(activeKey);
  }, [scan]);

  async function startScan() {
    if (!agent || !online || !state?.csrfToken || starting || (scan && active.has(scan.status))) return;
    setStarting(true);
    setError(null);
    try {
      const job = await api.post<ScanJobDto>("/devices/" + agent.id + "/scans", {}, state.csrfToken);
      window.sessionStorage.setItem(activeKey, job.id);
      setScan(job);
      await refreshScan(job.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the scan.");
    } finally {
      setStarting(false);
    }
  }

  const busy = starting || (!!scan && active.has(scan.status));
  const completed = !!dashboard.lastScanAt && !busy;
  const stale = !!dashboard.lastScanAt && Date.now() - new Date(dashboard.lastScanAt).getTime() > dashboard.scanReminderDays * 24 * 60 * 60_000;
  const scanFailed = scan?.status === "failed" || scan?.status === "cancelled";
  const headline = busy ? (scan?.status === "running" ? "Scanning your software" : "Preparing your scan") :
    completed ? (dashboard.updateCount ? String(dashboard.updateCount) + (stale ? " updates in saved scan" : " software updates available") : "Your software scan is complete") :
    !agent ? "Pair your Windows agent" : !online ? "Agent is offline" : "Software update intelligence";
  const detail = busy ? (scan?.status === "running" ? "Reading installed applications and checking trusted package matches. This can take a few minutes." : "Waiting for the paired Windows agent to begin its read-only scan.") :
    completed ? dashboard.inventoryCount.toLocaleString() + " saved applications · Last scan: " + formatDate(dashboard.lastScanAt!) + (stale ? ` · Older than ${dashboard.scanReminderDays} days` : "") + (!online ? " · Agent offline" : "") :
    !agent ? "Connect the local agent in Settings to scan this computer." : !online ? "Start the paired agent, then scan this computer." : "Keep your installed software up to date and secure.";

  return <section className="scan-stage" aria-labelledby="scan-title">
    <div className="scan-stage-heading" aria-live="polite">
      {agent && (
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[#3b3b3d] bg-[#222224] px-3.5 py-1 text-xs text-[#d1d1d1]">
          <span className={`inline-block h-2 w-2 rounded-full ${online ? "bg-[#32d56a] shadow-[0_0_6px_#32d56a]" : "bg-[#777]"}`} />
          <span>Device: <strong>{agent.name}</strong></span>
          <span className="text-[#999]">({online ? "Online" : "Offline"})</span>
        </div>
      )}
      <h1 id="scan-title" className={completed ? "scan-heading-complete" : ""}>{headline}</h1>
      <p>{detail}</p>
    </div>
    <div className={"scan-orbit" + (busy ? " is-scanning" : "") + (completed ? " is-complete" : "")}>
      <div className="scan-orbit-mid"><div className="scan-orbit-inner">
        {completed ? <Link href={dashboard.updateCount ? "/updates" : "/applications"} className="scan-action" aria-label={dashboard.updateCount ? "Review available updates" : "View scanned applications"}><Check className="scan-action-icon" aria-hidden="true" /><span className="scan-action-label scan-action-label-small">{dashboard.updateCount ? "REVIEW" : "VIEW"}</span><small>{dashboard.updateCount ? "UPDATES" : "APPLICATIONS"}</small></Link> :
        !agent ? <Link href="/settings" className="scan-action" aria-label="Pair Windows agent in settings"><ScanSearch className="scan-action-icon" aria-hidden="true" /><span className="scan-action-label scan-action-label-small">PAIR</span><small>WINDOWS AGENT</small></Link> :
        <button type="button" className="scan-action" onClick={() => void startScan()} disabled={!online || busy} aria-label={busy ? "Software scan in progress" : online ? "Start read-only software scan" : "Windows agent offline"}>
          {busy ? <LoaderCircle className="scan-action-icon scan-spinner" aria-hidden="true" /> : online ? <ScanSearch className="scan-action-icon" aria-hidden="true" /> : <WifiOff className="scan-action-icon" aria-hidden="true" />}
          <span className="scan-action-label">{busy ? "SCANNING" : online ? "SCAN" : "OFFLINE"}</span><small>{busy ? scan?.status === "queued" ? "WAITING FOR AGENT" : "READ-ONLY CHECK" : "INSTALLED SOFTWARE"}</small>
        </button>}
      </div></div>
    </div>
    <div className="scan-stage-footer" aria-live="polite">
      {completed ? <><button className="scan-again" onClick={() => void startScan()} disabled={!online || starting}><RotateCw className="h-4 w-4" /> Scan again</button><Link href={dashboard.updateCount ? "/updates" : "/applications"} className="scan-review-link">{dashboard.updateCount ? "Review verified updates" : "View applications"}<ArrowRight className="h-4 w-4" /></Link></> :
        busy ? <span>{scan?.status === "running" ? "Scanning this computer · read-only" : "Scan queued · waiting for agent"}</span> :
        <span>{dashboard.lastScanAt ? "Previous scan: " + formatDate(dashboard.lastScanAt) : "Click the circle to scan this computer"}</span>}
      {scanFailed && !busy && <p className="scan-error" role="alert">Latest scan {scan.status.replaceAll("_", " ")}{scan.errorCode ? " (" + scan.errorCode + ")" : ""}. Saved results above are from the earlier successful scan.</p>}
      {error && <p className="scan-error" role="alert">{error}</p>}
      {!online && agent && <Link href="/settings" className="scan-review-link">Check agent connection <ArrowRight className="h-4 w-4" /></Link>}
    </div>
  </section>;
}
