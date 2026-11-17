"use client";

import Link from "next/link";
import { ArrowRight, PackageCheck } from "lucide-react";
import type { ApplicationDto, Page } from "@updatepilot/contracts";
import { ErrorState, LoadingState } from "@/components/DataState";
import { useLiveQuery } from "@/components/useLiveQuery";

export function UpdateHighlights({ scanned }: { scanned: boolean }) {
  const { data, error, loading, reload } = useLiveQuery<Page<ApplicationDto>>("/updates?pageSize=5");

  return <section className="panel overflow-hidden" aria-labelledby="updates-heading">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-5 dark:border-slate-800 sm:px-6">
      <div><h3 id="updates-heading" className="text-lg font-semibold">Available updates</h3><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Verified WinGet matches from the latest scan</p></div>
      <Link href="/updates" className="inline-flex items-center gap-1 text-sm font-semibold text-[#df343c] hover:underline dark:text-[#ff777b]">Review all <ArrowRight className="h-4 w-4" /></Link>
    </div>
    {loading && !data ? <div className="p-6"><LoadingState /></div> : error && !data ? <div className="p-6"><ErrorState message={error} retry={reload} /></div> : data?.items.length ? <div className="divide-y divide-slate-100 dark:divide-slate-800">{data.items.map(item => <Link key={item.id} href={`/applications/${item.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 dark:hover:bg-white/5 dark:focus-visible:bg-white/5 sm:px-6"><div className="flex min-w-0 items-center gap-3"><div className="rounded-xl bg-[#f03940]/10 p-2.5 text-[#df343c] dark:text-[#ff777b]"><PackageCheck className="h-5 w-5" /></div><div className="min-w-0"><div className="truncate font-semibold">{item.displayName}</div><div className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{item.packageId} · {item.publisher}</div></div></div><div className="flex items-center gap-2 font-mono text-xs text-slate-600 dark:text-slate-300"><span>{item.installedVersion}</span><ArrowRight className="h-3.5 w-3.5 text-[#df343c]" /><span className="font-semibold text-[#df343c] dark:text-[#ff777b]">{item.availableVersion}</span></div></Link>)}</div> : <p className="px-6 py-10 text-sm text-slate-500 dark:text-slate-400">{scanned ? "No verified updates were found. Unsupported and uncertain matches remain visible in Applications." : "Run a scan to see real update results."}</p>}
  </section>;
}
