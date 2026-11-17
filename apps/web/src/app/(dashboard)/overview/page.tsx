"use client";

import { useEffect } from "react";
import type { DashboardDto } from "@updatepilot/contracts";
import { ErrorState, LoadingState } from "@/components/DataState";
import { ScanCenter } from "@/components/ScanCenter";
import { useLiveQuery } from "@/components/useLiveQuery";

export default function OverviewPage() {
  const { data, error, loading, reload } = useLiveQuery<DashboardDto>("/dashboard");
  useEffect(() => {
    const timer = window.setInterval(reload, 10000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return loading && !data ? <LoadingState /> : error && !data ? <ErrorState message={error} retry={reload} /> : data ? <ScanCenter dashboard={data} onCompleted={reload} /> : null;
}
