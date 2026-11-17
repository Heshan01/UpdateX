"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { ApplicationDetailDto, ReleaseInfoDto } from "@updatepilot/contracts";
import { EmptyState, ErrorState, LoadingState } from "@/components/DataState";
import { PageIntro, StatusPill } from "@/components/PageParts";
import { useLiveQuery } from "@/components/useLiveQuery";
import { formatDate } from "@/lib/format";

export default function ApplicationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useLiveQuery<ApplicationDetailDto>(`/applications/${id}`);
  const { data: release, loading: releaseLoading } = useLiveQuery<ReleaseInfoDto>(`/applications/${id}/release-info`);
  const storeFamily = data?.updateStatus === "store_managed" ? data.observations.find(item => item.evidenceType === "appx")?.packageFamilyName : null;
  return <>
    <Link href="/applications" className="mb-5 inline-block rounded-sm text-sm font-medium text-[#bf352f] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e03938] dark:text-[#ff777b]">← All applications</Link>
    {loading && !data ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !data ? <EmptyState title="Application unavailable" description="This observation may belong to an older scan." /> : <>
      <PageIntro eyebrow="Installation evidence" title={data.displayName} description="One logical installation, with its original Windows and WinGet observations preserved below." />
      <div className="panel grid gap-5 p-6 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div><p className="text-slate-500">Installed version</p><p className="mt-1 font-mono font-semibold">{data.installedVersion ?? "Unknown"}</p></div>
        <div><p className="text-slate-500">Observed in saved scan</p><p className="mt-1">{formatDate(data.observedAt)}</p></div>
        <div><p className="text-slate-500">Publisher</p><p className="mt-1 font-semibold">{data.publisher ?? "Unknown"}</p></div>
        <div><p className="text-slate-500">Package ID</p><p className="mt-1 break-all font-mono">{data.packageId ?? "Unmatched"}</p></div>
        <div><p className="text-slate-500">Available version</p><p className="mt-1 font-mono">{data.availableVersion ?? "Information unavailable"}</p></div>
        <div><p className="text-slate-500">Inventory source</p><p className="mt-1">{data.observations.map(item => item.evidenceType === "appx" ? "Windows package" : item.evidenceType === "winget" ? "WinGet" : "Uninstall registry").filter((value, index, all) => all.indexOf(value) === index).join(" + ")}</p></div>
        <div><p className="text-slate-500">Update method</p><p className="mt-1">{data.updateStatus === "store_managed" ? "Microsoft Store" : data.matchStatus === "verified" && data.source === "winget" ? "WinGet through UpdateX" : "No verified UpdateX method"}</p></div>
        <div><p className="text-slate-500">Installation</p><p className="mt-1">{data.installationType === "web_app" ? "Browser web app" : data.installationType === "winget_only" ? "WinGet-only record" : data.installationType === "windows_app" ? "Windows app (Store-managed)" : "Desktop application"}{data.installScope ? ` · ${data.installScope}` : ""}{data.architecture ? ` · ${data.architecture}` : ""}</p></div>
        <div><p className="text-slate-500">Package match</p><p className="mt-1"><StatusPill status={data.matchStatus} /></p></div>
        <div><p className="text-slate-500">Update status</p><p className="mt-1"><StatusPill status={data.updateStatus} /></p></div>
        <div className="sm:col-span-2 lg:col-span-3"><p className="text-slate-500">Evidence assessment</p><p className="mt-1">{data.matchReason ?? "No assessment recorded."}</p></div>
      </div>
      {storeFamily && <button className="button-secondary mt-4" onClick={() => {
        if (window.updatePilotDesktop) void window.updatePilotDesktop.openMicrosoftStoreProduct(storeFamily).catch(() => window.alert("The Microsoft Store could not open this package page."));
        else window.location.href = "ms-windows-store://pdp/?PFN=" + encodeURIComponent(storeFamily);
      }}>Open in Microsoft Store</button>}
      <section className="panel mt-5 p-6" aria-labelledby="release-heading"><h3 id="release-heading" className="text-lg font-semibold">Official release information</h3>
        {releaseLoading && !release ? <p className="mt-2 text-sm">Checking official release metadata…</p> : release?.status === "available" ? <div className="mt-3 space-y-2 text-sm"><p><strong>Version:</strong> {release.version}</p><p><strong>Release date:</strong> {release.releaseDate ? formatDate(release.releaseDate) : "Information unavailable"}</p><p><strong>Source:</strong> <a href={release.officialUrl!} target="_blank" rel="noopener noreferrer" className="text-[#ff8a00] underline">{release.source} ↗</a></p><div><strong>Release notes:</strong><p className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[#bdbdbd]">{release.notes ?? "Information unavailable"}</p></div></div> : <p className="mt-2 text-sm text-[#bdbdbd]">Information unavailable. No exact release entry was verified from a known official source for this package and version.</p>}
      </section>
      <section className="mt-8" aria-labelledby="observations-title">
        <h3 id="observations-title" className="mb-4 text-xl font-semibold">Source observations ({data.observations.length})</h3>
        {data.observations.length ? <div className="grid gap-4">{data.observations.map((observation, index) => <div key={`${observation.evidenceType}-${index}`} className="panel p-5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2"><strong>{observation.evidenceType === "registry" ? "Windows uninstall registry" : observation.evidenceType === "appx" ? "Windows app package" : "WinGet installed package"}</strong><span className="text-xs text-slate-500">{observation.installScope ?? "Scope unknown"}{observation.architecture ? ` · ${observation.architecture}` : ""}</span></div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2"><div><dt className="text-slate-500">Observed name</dt><dd>{observation.displayName}</dd></div><div><dt className="text-slate-500">Observed version</dt><dd className="font-mono">{observation.installedVersion ?? "Unknown"}</dd></div><div><dt className="text-slate-500">Publisher</dt><dd>{observation.publisher ?? "Not recorded by this source"}</dd></div><div><dt className="text-slate-500">Package or registry identity</dt><dd className="break-all font-mono text-xs">{observation.packageId ?? observation.packageFamilyName ?? [observation.registryHive, observation.registryView, observation.registryKey].filter(Boolean).join(" / ")}</dd></div>{observation.installLocation && <div className="sm:col-span-2"><dt className="text-slate-500">Install location</dt><dd className="break-all font-mono text-xs">{observation.installLocation}</dd></div>}</dl>
        </div>)}</div> : <p className="text-sm text-slate-500">This historical scan predates source provenance capture.</p>}
      </section>
    </>}
  </>;
}
