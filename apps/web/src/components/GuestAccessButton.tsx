"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AuthState } from "@updatepilot/contracts";
import { useAuth } from "./AuthProvider";
import { api } from "@/lib/api";
import { AccessError } from "./AccessLayout";

export function GuestAccessButton({ className }: { className?: string }) {
  const router = useRouter();
  const { accept } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enter() {
    setBusy(true); setError(null);
    try {
      const state = await api.post<AuthState>("/auth/guest", {});
      accept(state);
      router.replace("/overview");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enter Guest mode.");
    } finally { setBusy(false); }
  }

  return <div>
    <button type="button" className={className ?? "font-semibold text-[#ff8a00] hover:underline"} disabled={busy} onClick={() => void enter()}>{busy ? "Opening Guest workspace…" : "Continue as Guest"}</button>
    {error && <AccessError message={error} />}
  </div>;
}
