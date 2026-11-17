"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MonitorCheck, RefreshCw, ScanSearch, ShieldCheck, Unplug } from "lucide-react";
import type { DeviceDto, PairingLookupDto, ScanJobDto } from "@updatepilot/contracts";
import { useAuth } from "@/components/AuthProvider";
import { ErrorState, LoadingState } from "@/components/DataState";
import { StatusPill } from "@/components/PageParts";
import { useLiveQuery } from "@/components/useLiveQuery";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";

const finished = new Set(["succeeded", "failed", "cancelled"]);

export function AgentManager() {
  const { state } = useAuth();
  const { data, loading, error, reload } = useLiveQuery<{ items: DeviceDto[] }>("/devices");
  const [code, setCode] = useState("");
  const [review, setReview] = useState<PairingLookupDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanJobDto | null>(null);
  const [rotationCode, setRotationCode] = useState("");
  const [rotationDeviceId, setRotationDeviceId] = useState("");
  const [rotationReview, setRotationReview] = useState<PairingLookupDto | null>(null);
  const [desktopAgent, setDesktopAgent] = useState<DesktopAgentStatus | null>(null);

  useEffect(() => {
    const bridge = window.updatePilotDesktop;
    if (!bridge) return;
    let active = true;
    const refreshDesktop = () => {
      void bridge.getAgentStatus().then(status => { if (active) setDesktopAgent(status); })
        .catch(() => { if (active) setDesktopAgent(null); });
    };
    refreshDesktop();
    const timer = window.setInterval(refreshDesktop, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(reload, 10000);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (desktopAgent?.pairing?.code) setCode(desktopAgent.pairing.code);
  }, [desktopAgent?.pairing?.code]);

  useEffect(() => {
    if (!scan || finished.has(scan.status)) return;
    const timer = window.setInterval(() => {
      void api.get<ScanJobDto>(`/scans/${scan.id}`).then(next => {
        setScan(next);
        if (finished.has(next.status)) {
          window.sessionStorage.removeItem("updatepilot.active-scan-id");
          reload();
        }
      }).catch(cause => setActionError(cause instanceof Error ? cause.message : "Could not refresh scan status."));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [scan, reload]);

  function csrf(): string {
    if (!state?.csrfToken) throw new Error("Choose Guest or sign in to manage the agent.");
    return state.csrfToken;
  }

  async function restartAgent() {
    const bridge = window.updatePilotDesktop;
    if (!bridge) return;
    setBusy(true); setActionError(null); setReview(null);
    try { setDesktopAgent(await bridge.restartAgent()); reload(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not restart the Windows agent."); }
    finally { setBusy(false); }
  }

  async function reviewCode() {
    setBusy(true); setActionError(null); setReview(null);
    try { setReview(await api.post<PairingLookupDto>("/devices/pairing/lookup", { code }, csrf())); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not find that pairing code."); }
    finally { setBusy(false); }
  }

  async function approve() {
    if (!review) return;
    setBusy(true); setActionError(null);
    try {
      const result = await api.post<{ deviceId: string; scan: ScanJobDto }>("/devices/pair", {
        code, fingerprint: review.fingerprint,
      }, csrf());
      window.sessionStorage.setItem("updatepilot.active-scan-id", result.scan.id);
      setReview(null); setCode(""); setScan(result.scan); reload();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not pair the agent."); }
    finally { setBusy(false); }
  }

  async function startScan(deviceId: string) {
    setBusy(true); setActionError(null);
    try {
      const job = await api.post<ScanJobDto>(`/devices/${deviceId}/scans`, {}, csrf());
      window.sessionStorage.setItem("updatepilot.active-scan-id", job.id);
      setScan(job);
    }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not queue a scan."); }
    finally { setBusy(false); }
  }

  async function revoke(device: DeviceDto) {
    if (!window.confirm(`Revoke ${device.name}? Its key will stop working immediately. A running update may need manual verification.`)) return;
    setBusy(true); setActionError(null);
    try { await api.post<void>(`/devices/${device.id}/revoke`, {}, csrf()); reload(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not revoke the agent."); }
    finally { setBusy(false); }
  }

  async function reviewRotation() {
    setBusy(true); setActionError(null); setRotationReview(null);
    try { setRotationReview(await api.post<PairingLookupDto>("/devices/pairing/lookup", { code: rotationCode }, csrf())); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not review the new agent key."); }
    finally { setBusy(false); }
  }

  async function approveRotation() {
    if (!rotationReview || !rotationDeviceId) return;
    const device = data?.items.find(item => item.id === rotationDeviceId);
    if (!device || device.connection !== "offline") { setActionError("Stop the old agent and wait for it to show offline."); return; }
    if (!window.confirm(`Replace the key for ${device.name}? The old agent key will stop working immediately.`)) return;
    setBusy(true); setActionError(null);
    try {
      await api.post(`/devices/${device.id}/rotate-key`, { code: rotationCode, fingerprint: rotationReview.fingerprint }, csrf());
      setRotationCode(""); setRotationReview(null); reload();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not rotate the agent key."); }
    finally { setBusy(false); }
  }

  const managedDevice = data?.items.find(device => device.id === desktopAgent?.deviceId && !device.revokedAt);

  return <section className="panel mt-6 overflow-hidden" aria-labelledby="agent-heading">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-5 dark:border-[#3b3b3d]">
      <div><h3 id="agent-heading" className="text-lg font-semibold">Windows agent</h3><p className="mt-1 text-sm text-slate-500">Pair a local agent, run real scans, and review its connection state.</p></div>
      <button className="button-secondary flex items-center gap-2" onClick={reload}><RefreshCw className="h-4 w-4" /> Refresh</button>
    </div>
    {actionError && <p className="mx-6 mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-900/20 dark:text-rose-300" role="alert">{actionError}</p>}
    {desktopAgent?.pairing && <div className="mx-6 mt-5 rounded border border-[#ff8a00] p-4 text-sm" role="status"><strong>Desktop agent is waiting for approval</strong><p className="mt-2">Pairing code: <code className="font-mono font-semibold">{desktopAgent.pairing.code}</code></p><p className="mt-2 break-all">Agent fingerprint: <code className="font-mono">{desktopAgent.pairing.fingerprint}</code></p><p className="mt-2 text-xs text-[#aaa]">Review this code below, compare the API fingerprint with this agent fingerprint, then explicitly approve. Expires {formatDate(desktopAgent.pairing.expiresAt)}.</p></div>}
    {desktopAgent && (desktopAgent.processState === "stopped" || desktopAgent.processState === "error" || desktopAgent.processState === "unavailable") && <div className="mx-6 mt-5 text-sm"><p role="alert">{desktopAgent.error ?? "The Windows agent is not running."}</p><button className="button-secondary mt-3" disabled={busy} onClick={() => void restartAgent()}>Start agent</button></div>}
    {desktopAgent?.processState === "external_services" && <div className="mx-6 mt-5 text-sm text-[#aaa]"><p>{desktopAgent.error ?? "Another local agent is running. Its reported connection and update capability are shown below."}</p>{desktopAgent.error && <button className="button-secondary mt-3" disabled={busy} onClick={() => void restartAgent()}>Restart agent after closing the old one</button>}</div>}
    {scan && <div className="mx-6 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm dark:border-orange-900/60 dark:bg-orange-900/20" role="status"><div><strong>Scan {scan.status.replaceAll("_", " ")}</strong><p className="mt-1 text-slate-500">{scan.errorCode ? `Reason: ${scan.errorCode}` : scan.status === "succeeded" ? "Real observations are saved in Applications." : "The agent will report its result here."}</p></div>{scan.status === "succeeded" && <Link className="font-semibold text-orange-800 underline dark:text-orange-300" href="/applications">View applications</Link>}</div>}
    {loading && !data ? <div className="p-6"><LoadingState /></div> : error ? <div className="p-6"><ErrorState message={error} retry={reload} /></div> : data?.items.length && !desktopAgent?.pairing ? <div className="divide-y divide-slate-100 dark:divide-[#3b3b3d]">{data.items.map(device => <div key={device.id} className="flex flex-wrap items-center gap-4 px-6 py-5"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-[#bf352f] dark:text-[#ff7771]"><MonitorCheck className="h-5 w-5" /></div><div className="min-w-48 flex-1"><div className="font-semibold">{device.name}</div><div className="mt-1 text-xs text-slate-500">Agent {device.agentVersion ?? "unknown"} · {device.osVersion ?? "Windows version unknown"} · Last heartbeat {formatDate(device.lastHeartbeatAt)} · {device.connection === "online" ? device.executionMode === "update_enabled" ? "Update-enabled" : "Read-only" : "Last reported mode: " + (device.executionMode === "update_enabled" ? "update-enabled" : "read-only")}</div></div><StatusPill status={device.connection} />{!device.revokedAt && <><button className="button-secondary flex items-center gap-2" disabled={busy} onClick={() => void startScan(device.id)}><ScanSearch className="h-4 w-4" /> Start scan</button><button className="text-sm font-semibold text-rose-600 hover:underline disabled:opacity-50" disabled={busy} onClick={() => void revoke(device)}><Unplug className="mr-1 inline h-4 w-4" />Revoke</button></>}</div>)}</div> : <div className="px-6 py-8"><div className="flex items-center gap-3"><ShieldCheck className="h-6 w-6 text-[#bf352f] dark:bg-[#e03938]/10 dark:text-[#ff7771]" /><div><h4 className="font-semibold">Pair your local agent</h4><p className="mt-1 text-sm text-slate-500">The bundled agent supplies the code above. Enter a code manually only when running the agent separately.</p></div></div><div className="mt-6 flex flex-col gap-3 sm:flex-row"><label className="min-w-0 flex-1"><span className="label">Pairing code</span><input className="input mt-2 font-mono uppercase tracking-widest" value={code} maxLength={13} autoComplete="off" placeholder="XXXXXX-XXXXXX" onChange={event => { setCode(event.target.value.toUpperCase()); setReview(null); }} /></label><button className="button-secondary self-end" disabled={busy || !/^[A-Z2-9]{6}-[A-Z2-9]{6}$/.test(code)} onClick={() => void reviewCode()}>Review agent</button></div>{review && <div className="mt-5 rounded-xl border border-orange-200 bg-orange-50 p-5 text-sm dark:border-orange-900/60 dark:bg-orange-900/20"><h5 className="font-semibold">Confirm this agent</h5><dl className="mt-3 grid gap-2 sm:grid-cols-2"><div><dt className="text-slate-500">Device</dt><dd className="font-medium">{review.deviceName}</dd></div><div className="sm:col-span-2"><dt className="text-slate-500">Key fingerprint</dt><dd className="break-all font-mono text-xs">{review.fingerprint}</dd></div></dl><p className="mt-3 text-xs text-slate-500">Compare this fingerprint with the agent fingerprint above (or its console) before approving. Approval queues the first scan.</p><button className="button-primary mt-4" disabled={busy || (desktopAgent?.pairing ? review.fingerprint !== desktopAgent.pairing.fingerprint : false)} onClick={() => void approve()}>Approve and pair</button></div>}</div>}
    {desktopAgent?.managed && managedDevice && <div className="border-t border-[#3b3b3d] px-6 py-5" aria-label="Desktop agent status">
      <h4 className="font-semibold">Software update readiness</h4>
      <p className="mt-1 text-sm text-[#aaa]" role="status">{managedDevice.name}: {managedDevice.connection === "online" && managedDevice.executionMode === "update_enabled" ? "Ready for confirmed updates" : managedDevice.connection === "online" ? "This running agent is read-only; restart the updated desktop app" : "Agent offline"} · Last heartbeat {formatDate(managedDevice.lastHeartbeatAt)}</p>
      {desktopAgent.error && <p className="mt-3 text-sm text-[#ff777b]" role="alert">{desktopAgent.error}</p>}
      <p className="mt-3 text-xs text-[#aaa]">Opening UpdateX never queues an update. Every package still requires its own review and confirmation.</p>
    </div>}
    {data?.items.some(device => !device.revokedAt) && <div className="border-t border-[#3b3b3d] px-6 py-5">
      <h4 className="font-semibold">Rotate or recover an agent key</h4>
      <p className="mt-2 text-sm text-[#aaa]">Stop the old agent, then run the local agent with <code>--rotate-key</code> (or <code>--recover-key</code> if its old key is missing). The new key remains pending until you compare its fingerprint and approve it here. Existing scans and history stay with this device.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <label className="min-w-48 flex-1"><span className="label">Existing offline device</span><select className="input mt-2" value={rotationDeviceId} onChange={event => { setRotationDeviceId(event.target.value); setRotationReview(null); }}><option value="">Select device</option>{data.items.filter(device => !device.revokedAt).map(device => <option key={device.id} value={device.id}>{device.name} · {device.connection}</option>)}</select></label>
        <label className="min-w-48 flex-1"><span className="label">New key pairing code</span><input className="input mt-2 font-mono uppercase" value={rotationCode} maxLength={13} autoComplete="off" onChange={event => { setRotationCode(event.target.value.toUpperCase()); setRotationReview(null); }} placeholder="XXXXXX-XXXXXX" /></label>
        <button className="button-secondary self-end" disabled={busy || !rotationDeviceId || !/^[A-Z2-9]{6}-[A-Z2-9]{6}$/.test(rotationCode)} onClick={() => void reviewRotation()}>Review new key</button>
      </div>
      {rotationReview && <div className="mt-4 rounded border border-[#ff8a00] p-4 text-sm"><p>Agent computer: <strong>{rotationReview.deviceName}</strong></p><p className="mt-2">Compare this fingerprint with the new agent console:</p><code className="mt-2 block break-all">{rotationReview.fingerprint}</code><button className="button-primary mt-4" disabled={busy || data.items.find(device => device.id === rotationDeviceId)?.connection !== "offline"} onClick={() => void approveRotation()}>Approve key replacement</button></div>}
    </div>}
  </section>;
}
