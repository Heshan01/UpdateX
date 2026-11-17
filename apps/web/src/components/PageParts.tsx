import type { ApplicationDto } from "@updatepilot/contracts";
import Link from "next/link";
import { ArrowUpRight, Package2 } from "lucide-react";
import { labelStatus } from "@/lib/format";

export function PageIntro({ eyebrow, title, description, trailing }: { eyebrow: string; title: string; description: string; trailing?: React.ReactNode }) {
  return <div className="desktop-page-intro"><div><p className="desktop-eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{trailing}</div>;
}

export function StatusPill({ status }: { status: string }) {
  const good = ["verified", "succeeded", "online", "up_to_date"].includes(status);
  const available = status === "available";
  const warn = ["ambiguous", "unknown_version", "update_unknown", "no_verified_match", "blocked_or_pinned", "source_unavailable", "reboot_required", "action_required", "execution_unknown"].includes(status);
  const failed = ["failed", "verification_failed"].includes(status);
  return <span className={"desktop-status " + (good ? "good" : available ? "available" : warn ? "warning" : failed ? "failed" : "muted")}><span className="desktop-status-dot" />{labelStatus(status)}</span>;
}

const groups = [
  { title: "Updates available", test: (item: ApplicationDto) => item.updateStatus === "available" && item.matchStatus === "verified" },
  { title: "Windows apps · check in Microsoft Store", test: (item: ApplicationDto) => item.updateStatus === "store_managed" },
  { title: "Up to date", test: (item: ApplicationDto) => item.updateStatus === "up_to_date" },
  { title: "Needs review", test: (item: ApplicationDto) => !["available", "up_to_date", "store_managed", "unsupported", "unsupported_method"].includes(item.updateStatus) && item.matchStatus !== "unsupported" },
  { title: "Unsupported update method", test: (item: ApplicationDto) => ["unsupported", "unsupported_method"].includes(item.updateStatus) },
];

export function ApplicationTable({ items, showUpdate = true }: { items: ApplicationDto[]; showUpdate?: boolean }) {
  const assigned = new Set<string>();
  const sections = groups.map(group => {
    const rows = items.filter(item => !assigned.has(item.id) && group.test(item));
    rows.forEach(item => assigned.add(item.id));
    return { title: group.title, rows };
  });
  const other = items.filter(item => !assigned.has(item.id));
  if (other.length) sections.push({ title: "Other applications", rows: other });
  return <div className="desktop-app-list">
    {sections.filter(section => section.rows.length).map(section => <section key={section.title} aria-label={section.title}>
      <div className="desktop-list-heading"><h2>{section.title}</h2><span>{section.rows.length} on this page</span></div>
      <div className="desktop-list-rows">{section.rows.map(item => <div className="desktop-app-row" key={item.id}>
        <span className="desktop-app-icon" aria-hidden="true"><Package2 className="h-5 w-5" /></span>
        <div className="desktop-app-main"><Link href={"/applications/" + item.id} className="desktop-app-name">{item.displayName}</Link><span className="desktop-app-meta">{item.publisher ?? "Publisher unknown"}{item.installScope ? " · " + item.installScope : ""}{item.architecture ? " · " + item.architecture : ""} · {item.installationType === "windows_app" ? "Windows app" : item.installationType === "winget_only" ? "WinGet" : "Windows registry"}</span><span className="desktop-app-package" title={item.packageId ?? undefined}>{item.matchStatus === "verified" && item.packageId ? `WinGet: ${item.packageId}` : item.installationType === "windows_app" ? "Microsoft Store managed" : "No verified WinGet package identity"}{item.observationCount > 1 ? " · " + item.observationCount + " source observations" : ""}</span></div>
        <div className="desktop-app-versions"><span>Installed <strong>{item.installedVersion ?? "Unknown"}</strong></span><span>Available <strong className={item.updateStatus === "available" ? "version-available" : ""}>{item.availableVersion ?? "—"}</strong></span></div>
        <div className="desktop-app-right"><StatusPill status={showUpdate ? item.updateStatus : item.matchStatus} />{item.updateStatus === "store_managed" ? <button className="desktop-row-detail" onClick={() => { if (window.updatePilotDesktop) void window.updatePilotDesktop.openMicrosoftStore().catch(() => window.alert("Microsoft Store could not be opened on this Windows installation.")); else window.location.href = "ms-windows-store://downloadsandupdates"; }}>Check Store updates</button> : item.updateStatus === "available" && item.matchStatus === "verified" && showUpdate ? <Link className="desktop-row-action" href={"/updates?applicationId=" + encodeURIComponent(item.id)} aria-label={"Review update for " + item.displayName}>Review <ArrowUpRight className="h-3.5 w-3.5" /></Link> : <Link className="desktop-row-detail" href={"/applications/" + item.id}>Details</Link>}</div>
      </div>)}</div>
    </section>)}
  </div>;
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (page: number) => void }) {
  if (!total) return null;
  return <div className="desktop-pagination"><span>{total.toLocaleString()} results · Page {page} of {totalPages}</span><div><button className="button-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button><button className="button-secondary" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</button></div></div>;
}
