"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export function useLiveQuery<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.get<T>(path).then(value => { if (active) { setData(value); setError(null); } })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "The request failed."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, revision]);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  return { data, error, loading, reload };
}
