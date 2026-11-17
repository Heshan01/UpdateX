"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { AccessError, AccessLayout } from "@/components/AccessLayout";
import { useAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

export default function ActivatePage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post<{ activated: boolean }>("/license/activate", { key });
      setKey("");
      await refresh();
      router.replace("/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The license could not be activated.");
    } finally { setBusy(false); }
  }

  return <AccessLayout eyebrow="Offline license activation" title="Activate UpdateX"
    description="Enter your UpdateX license key to use this Windows computer. The key is checked locally; no internet connection or account is needed.">
    <form className="mt-8 space-y-5" onSubmit={event => void submit(event)}>
      <div><label className="block text-sm font-semibold" htmlFor="activation-key">License key</label>
        <input id="activation-key" className="auth-input mt-2 font-mono uppercase" type="password"
          autoComplete="off" spellCheck={false} required maxLength={28}
          placeholder="UPDX-XXXXX-XXXXX-XXXXX-XXXXX" value={key}
          onChange={event => setKey(event.target.value.toUpperCase())} /></div>
      {error && <AccessError message={error} />}
      <button className="w-full rounded-md bg-[#ff343c] px-4 py-3 font-semibold text-white disabled:opacity-50"
        type="submit" disabled={busy || !key.trim()}>{busy ? "Activating…" : "Activate license"}</button>
    </form>
    <p className="mt-5 text-xs leading-5 text-[#aaa]">The license key is never saved in the browser. This local browser workflow stores an encrypted activation for your Windows user. The installed desktop app has its own first-launch activation screen.</p>
  </AccessLayout>;
}
