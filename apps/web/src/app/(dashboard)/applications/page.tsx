"use client";

import { useMemo, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import type { ApplicationDto, Page } from "@updatepilot/contracts";
import { EmptyState, ErrorState, LoadingState } from "@/components/DataState";
import { DeviceSelector } from "@/components/DeviceSelector";
import { useDevice } from "@/components/DeviceProvider";
import { ApplicationTable, PageIntro, Pagination } from "@/components/PageParts";
import { useLiveQuery } from "@/components/useLiveQuery";
import { downloadCsv } from "@/lib/download";
import { formatDate } from "@/lib/format";

export default function ApplicationsPage() {
  const { selectedDeviceId, selectedDevice } = useDevice();
  const [search, setSearch] = useState("");
  const [match, setMatch] = useState("");
  const [update, setUpdate] = useState("");
  const [windowsAppsOnly, setWindowsAppsOnly] = useState(false);
  const [sort, setSort] = useState("name");
  const [direction, setDirection] = useState("asc");
  const [page, setPage] = useState(1);
  const [exportError, setExportError] = useState<string | null>(null);

  const path = useMemo(() => {
    const query = new URLSearchParams({ page: String(page), pageSize: "20", sort, direction });
    if (selectedDeviceId) query.set("deviceId", selectedDeviceId);
    if (search.trim()) query.set("search", search.trim());
    if (match) query.set("match", match);
    if (update) query.set("update", update);
    if (windowsAppsOnly) query.set("installationType", "windows_app");
    return `/applications?${query}`;
  }, [page, selectedDeviceId, search, match, update, sort, direction, windowsAppsOnly]);

  const { data, error, loading, reload } = useLiveQuery<Page<ApplicationDto>>(path);
  const filtersActive = !!(search || match || update || windowsAppsOnly);

  const handleExport = () => {
    const exportPath = selectedDeviceId ? `/applications/export.csv?deviceId=${selectedDeviceId}` : "/applications/export.csv";
    const filename = selectedDevice ? `updatex-${selectedDevice.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}-applications.csv` : "updatex-applications.csv";
    void downloadCsv(exportPath, filename).catch(cause => setExportError(cause instanceof Error ? cause.message : "Export failed."));
  };

  return (
    <>
      <PageIntro
        eyebrow="Software inventory"
        title="Applications"
        description={`Installed software on ${selectedDevice ? selectedDevice.name : "your paired Windows device"}${data?.items[0] ? ` · Scanned ${formatDate(data.items[0].observedAt)}` : ""}. Package identity and update status reflect that scan's evidence.`}
        trailing={
          <div className="flex flex-wrap items-center gap-2">
            <DeviceSelector />
            <button className="button-secondary" onClick={handleExport}>
              Export CSV
            </button>
            <button className="button-secondary" onClick={reload}>
              Refresh view
            </button>
          </div>
        }
      />
      {exportError && <p role="alert" className="desktop-update-error">{exportError}</p>}
      <div className="panel overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-5 dark:border-slate-800 xl:flex-row xl:items-center">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={windowsAppsOnly} onChange={event => { setWindowsAppsOnly(event.target.checked); setPage(1); }} /> Windows apps
          </label>
          <label className="relative block min-w-0 flex-1">
            <span className="sr-only">Search applications</span>
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input className="input pl-10" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="Search name, publisher, or package ID" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <SlidersHorizontal className="hidden h-4 w-4 text-slate-400 sm:block" aria-hidden="true" />
            <label>
              <span className="sr-only">Match status</span>
              <select className="input min-w-36" value={match} onChange={event => { setMatch(event.target.value); setPage(1); }}>
                <option value="">All matches</option>
                <option value="verified">Verified</option>
                <option value="ambiguous">Ambiguous</option>
                <option value="unmatched">Unmatched</option>
                <option value="unsupported">Externally managed</option>
              </select>
            </label>
            <label>
              <span className="sr-only">Update status</span>
              <select className="input min-w-40" value={update} onChange={event => { setUpdate(event.target.value); setPage(1); }}>
                <option value="">All updates</option>
                <option value="available">Available</option>
                <option value="up_to_date">Up to date</option>
                <option value="no_verified_match">No verified match</option>
                <option value="update_unknown">Status unknown</option>
                <option value="store_managed">Store managed</option>
                <option value="unsupported_method">Unsupported method</option>
                <option value="unknown_version">Unknown version</option>
                <option value="blocked_or_pinned">Blocked or pinned</option>
                <option value="unsupported">Legacy unsupported</option>
                <option value="source_unavailable">Source unavailable</option>
              </select>
            </label>
            <label>
              <span className="sr-only">Sort applications</span>
              <select className="input min-w-36" value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}>
                <option value="name">Name</option>
                <option value="publisher">Publisher</option>
                <option value="installedVersion">Installed version</option>
                <option value="updateStatus">Update status</option>
              </select>
            </label>
            <button className="button-secondary" onClick={() => setDirection(value => value === "asc" ? "desc" : "asc")} aria-label={`Sort ${direction === "asc" ? "descending" : "ascending"}`}>
              {direction === "asc" ? "A → Z" : "Z → A"}
            </button>
          </div>
        </div>
        {loading && !data ? (
          <div className="p-5"><LoadingState /></div>
        ) : error ? (
          <div className="p-5"><ErrorState message={error} retry={reload} /></div>
        ) : data && data.items.length ? (
          <>
            <ApplicationTable items={data.items} />
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} />
          </>
        ) : (
          <div className="p-5">
            <EmptyState
              title={filtersActive ? "No applications match these filters" : `No applications scanned yet for ${selectedDevice?.name ?? "this device"}`}
              description={filtersActive ? "Try another search or clear the filters." : "A completed scan from the paired Windows agent will populate this inventory. Click Scan in the sidebar to run a scan."}
              action={filtersActive ? <button className="button-secondary" onClick={() => { setSearch(""); setMatch(""); setUpdate(""); setWindowsAppsOnly(false); setPage(1); }}>Clear filters</button> : undefined}
            />
          </div>
        )}
      </div>
    </>
  );
}
