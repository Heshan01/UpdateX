"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { UpdateJobDto } from "@updatepilot/contracts";
import { ErrorState, LoadingState } from "@/components/DataState";
import { PageIntro, StatusPill } from "@/components/PageParts";
import { useLiveQuery } from "@/components/useLiveQuery";
import { formatDate } from "@/lib/format";

type JobDetail = UpdateJobDto & { events: { id: string; status: string; detail: string | null; createdAt: string; downloadPercent?: number | null; downloadedBytes?: number | null; totalBytes?: number | null }[] };

export default function JobHistoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useLiveQuery<JobDetail>(`/jobs/${encodeURIComponent(id)}`);
  return <>
    <PageIntro eyebrow="Update history" title="Job details" description="Recorded events for one exact package update." trailing={<Link href="/history" className="button-secondary">Back to History</Link>} />
    {loading && !data ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : data ? <div className="panel p-5"><div className="flex items-center justify-between gap-3"><h2 className="break-all text-lg font-semibold">{data.packageId}</h2><StatusPill status={data.status} /></div><p className="mt-1 text-sm text-[#aaa]">Source: {data.source}</p><dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-[#aaa]">Before</dt><dd>{data.installedVersion ?? "Unknown"}</dd></div><div><dt className="text-[#aaa]">Target</dt><dd>{data.targetVersion}</dd></div><div><dt className="text-[#aaa]">Verified installed</dt><dd>{data.observedVersion ?? "Not verified"}</dd></div></dl><p className="mt-4 text-xs text-[#aaa]">Requested {formatDate(data.createdAt)}{data.startedAt ? ` · Started ${formatDate(data.startedAt)}` : ""}{data.completedAt ? ` · Finished ${formatDate(data.completedAt)}` : ""}</p>{data.diagnosticCode && <p className="mt-2 text-sm text-[#ff8a00]">{data.diagnosticCode}{data.exitCode != null ? ` · WinGet exit ${data.exitCode}` : ""}</p>}<h3 className="mt-6 font-semibold">Events</h3><ol className="mt-2 space-y-2 border-l border-[#444] pl-4">{data.events.map(event => <li key={event.id} className="text-sm"><time className="text-xs text-[#aaa]">{formatDate(event.createdAt)}</time><p>{event.status.replaceAll("_", " ")}{event.detail ? ` · ${event.detail}` : ""}{event.downloadPercent != null ? ` · ${event.downloadPercent}% downloaded` : ""}{event.downloadedBytes != null && event.totalBytes != null ? ` · ${(event.downloadedBytes / 1048576).toFixed(1)} / ${(event.totalBytes / 1048576).toFixed(1)} MB` : ""}</p></li>)}</ol></div> : null}
  </>;
}
