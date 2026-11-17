"use client";

import Image from "next/image";
import Link from "next/link";
import { Laptop, Moon, ShieldCheck, Sun } from "lucide-react";
import type { SettingsDto, Theme } from "@updatepilot/contracts";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { PageIntro } from "@/components/PageParts";
import { AgentManager } from "@/components/AgentManager";
import { DeviceSelector } from "@/components/DeviceSelector";
import { useLiveQuery } from "@/components/useLiveQuery";
import { api } from "@/lib/api";

const themes = [
  { value: "system", title: "System", note: "Use Windows preference", icon: Laptop },
  { value: "light", title: "Light", note: "Bright interface", icon: Sun },
  { value: "dark", title: "Dark", note: "Charcoal interface", icon: Moon },
] as const;

export default function SettingsPage() {
  const { state, theme, setTheme } = useAuth();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<{ activated: boolean; maskedIdentifier?: string; activatedAt?: string; device?: string; error?: string } | null>(null);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [replacementKey, setReplacementKey] = useState("");
  useEffect(() => { if (window.updatePilotDesktop) void window.updatePilotDesktop.getLicenseStatus().then(setLicenseStatus).catch(() => undefined); }, []);
  async function deactivateLicense() {
    if (!window.updatePilotDesktop || !window.confirm("Remove this device's local activation? UpdateX will restart and require a valid license key. Active jobs must finish first.")) return;
    setLicenseBusy(true); setLicenseError(null);
    try { await window.updatePilotDesktop.deactivateLicense(); }
    catch (cause) { setLicenseError(cause instanceof Error ? cause.message : "Could not deactivate this device."); setLicenseBusy(false); }
  }
  async function changeLicense() {
    if (!window.updatePilotDesktop || !window.confirm("Change the activated license key on this device? UpdateX will restart. Active jobs must finish first.")) return;
    setLicenseBusy(true); setLicenseError(null);
    try { await window.updatePilotDesktop.changeLicense(replacementKey); setReplacementKey(""); }
    catch (cause) { setLicenseError(cause instanceof Error ? cause.message : "Could not change the license key."); setLicenseBusy(false); }
  }
  const { data: preferences, reload: reloadPreferences } = useLiveQuery<SettingsDto>("/settings");
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const saveReminder = async (days: number) => {
    if (!state?.csrfToken) return;
    setPreferenceBusy(true); setSaveError(null);
    try { await api.patch<SettingsDto>("/settings", { scanReminderDays: days }, state.csrfToken); reloadPreferences(); }
    catch (cause) { setSaveError(cause instanceof Error ? cause.message : "Could not save scan preference."); }
    finally { setPreferenceBusy(false); }
  };
  const choose = async (value: Theme) => {
    setSaving(true); setSaveError(null);
    try { await setTheme(value); }
    catch (cause) { setSaveError(cause instanceof Error ? cause.message : "Could not save theme."); }
    finally { setSaving(false); }
  };
  return <>
    <PageIntro
      eyebrow="Preferences & Devices"
      title="Settings"
      description="Appearance, your account, paired Windows devices, and agent downloads."
      trailing={<DeviceSelector />}
    />
    <div className="desktop-settings-grid">
      <section className="panel desktop-setting-section"><div className="desktop-setting-heading"><Sun className="h-4 w-4 text-[#ff8a00]" /><div><h2>Appearance</h2><p>Saved to your local owner account.</p></div></div>
        <div className="desktop-theme-options" role="group" aria-label="Theme preference">{themes.map(option => { const Icon = option.icon; return <button key={option.value} disabled={saving} onClick={() => void choose(option.value)} aria-pressed={theme === option.value} className={"desktop-theme-option" + (theme === option.value ? " selected" : "")}><Icon className="h-4 w-4" /><strong>{option.title}</strong><span>{option.note}</span></button>; })}</div>
        {saveError && <p className="desktop-update-error mt-3" role="alert">{saveError}</p>}
      </section>
      <section className="panel desktop-setting-section"><div className="desktop-setting-heading"><ShieldCheck className="h-4 w-4 text-[#32d56a]" /><div><h2>Local access</h2><p>An account is optional after offline license activation.</p></div></div>
        <dl className="desktop-account-data"><div><dt>Mode</dt><dd>{state?.mode === "guest" ? "Guest" : "Local account"}</dd></div><div><dt>Username</dt><dd>{state?.mode === "guest" ? "Not required" : state?.username}</dd></div><div><dt>Connection</dt><dd>Local only</dd></div></dl>{state?.mode === "guest" && <div className="mt-4 flex flex-wrap gap-2"><Link href="/sign-in" className="button-secondary inline-block">Sign In</Link><Link href="/sign-up" className="button-secondary inline-block">Sign Up</Link></div>}
      </section>
    </div>
    <section className="panel desktop-setting-section mt-5" aria-labelledby="scan-preferences-heading"><h2 id="scan-preferences-heading" className="text-lg font-semibold">Scan preferences</h2><p className="mt-1 text-sm text-[#bdbdbd]">Scans start only when you request them. Saved results remain available while the agent is offline.</p><label className="mt-4 block text-sm" htmlFor="scan-reminder">Mark saved results as old after</label><select id="scan-reminder" className="input mt-2 max-w-xs" value={preferences?.scanReminderDays ?? 7} disabled={!preferences || preferenceBusy} onChange={event => void saveReminder(Number(event.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select><p className="mt-4 text-sm text-[#bdbdbd]">History retention: all records are kept locally. UpdateX does not delete scan or update history automatically.</p></section>
    <AgentManager />
    {licenseStatus && <section className="panel desktop-setting-section mt-5" aria-labelledby="license-heading">
      <h2 id="license-heading" className="text-lg font-semibold">License Management</h2>
      <p className="mt-2 text-sm text-[#bdbdbd]">{licenseStatus.activated ? "Activated — validated locally on this Windows installation." : licenseStatus.error || "Not Activated"}</p>
      {licenseStatus.activated && <><p className="mt-2 text-sm">License: {licenseStatus.maskedIdentifier}</p><p className="mt-1 text-xs text-[#bdbdbd]">Activated: {licenseStatus.activatedAt ? new Date(licenseStatus.activatedAt).toLocaleString() : "Unknown"}</p><p className="mt-1 break-all text-xs text-[#999]">Device fingerprint: {licenseStatus.device}</p>
        <label className="mt-5 block text-sm font-semibold" htmlFor="replacement-license-key">Change license key</label><input id="replacement-license-key" className="input mt-2 max-w-md" type="password" autoComplete="off" spellCheck={false} maxLength={28} placeholder="UPDX-XXXXX-XXXXX-XXXXX-XXXXX" value={replacementKey} onChange={event => setReplacementKey(event.target.value)} />
        <div className="mt-3 flex flex-wrap gap-2"><button className="button-secondary" disabled={licenseBusy || !replacementKey} onClick={() => void changeLicense()}>Change license</button><button className="button-secondary" disabled={licenseBusy} onClick={() => void deactivateLicense()}>{licenseBusy ? "Working…" : "Remove local activation"}</button></div></>}
      <p className="mt-3 text-xs text-[#999]">Removing activation locks UpdateX after restart. Enter any valid existing key to activate again. Offline key-only validation cannot enforce a global device count.</p>
      {licenseError && <p className="desktop-update-error mt-3" role="alert">{licenseError}</p>}
    </section>}
    <section className="panel desktop-setting-section mt-5" aria-labelledby="about-updatex">
      <div className="flex flex-wrap items-center gap-5">
        <Image src="/branding/UpdateX_Logo.png" alt="UpdateX logo" width={240} height={160} className="h-auto w-[180px] max-w-full object-contain sm:w-[240px]" />
        <div className="min-w-0 flex-1"><h2 id="about-updatex" className="text-lg font-semibold">About UpdateX</h2><p className="mt-2 max-w-xl text-sm text-[#bdbdbd]">Local Windows software inventory and carefully verified update management. Your scans and history stay on this computer.</p><p className="mt-3 text-xs text-[#9c9c9c]">Version 0.1.0 · Installed software scanning with WinGet</p></div>
      </div>
    </section>
  </>;
}
