"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, UserRound, UserRoundPlus } from "lucide-react";
import type { AuthState } from "@updatepilot/contracts";
import { AccessError, AccessLayout } from "@/components/AccessLayout";
import { useAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";

export default function WelcomePage() {
  const router = useRouter();
  const { state, loading, error: connectionError, errorCode, refresh, accept } = useAuth();
  const [enteringGuest, setEnteringGuest] = useState(false);
  const [guestError, setGuestError] = useState<string | null>(null);

  useEffect(() => { if (state?.authenticated) router.replace("/overview"); }, [state?.authenticated, router]);

  async function continueAsGuest() {
    setEnteringGuest(true); setGuestError(null);
    try {
      const next = await api.post<AuthState>("/auth/guest", {});
      accept(next);
      router.replace("/overview");
    } catch (cause) {
      setGuestError(cause instanceof Error ? cause.message : "Could not enter Guest mode.");
    } finally { setEnteringGuest(false); }
  }

  return <AccessLayout eyebrow="Multi-device software intelligence" title="Welcome to UpdateX" description="Sign in or create an account to manage software updates across your Windows devices.">
    {loading ? <p className="mt-8 text-sm text-[#b7b7b7]" role="status">Checking your local session…</p> : connectionError ? <><AccessError message={connectionError} retry={() => void refresh()} />{errorCode === "LICENSE_REQUIRED" && <Link href="/activate" className="mt-4 inline-block rounded-md bg-[#ff343c] px-4 py-3 font-semibold text-white">Enter license key</Link>}</> : <>
      <div className="mt-8 grid gap-3">
        <Link href="/sign-in" className="flex items-center justify-between rounded-md border border-[#555] bg-[#303030] px-4 py-4 font-semibold text-white transition hover:border-[#ff343c] hover:bg-[#383838] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8a00]"><span className="flex items-center gap-3"><UserRound className="h-5 w-5 text-[#ff343c]" /> Sign In</span><ArrowRight className="h-4 w-4" /></Link>
        <Link href="/sign-up" className="flex items-center justify-between rounded-md border border-[#555] bg-[#303030] px-4 py-4 font-semibold text-white transition hover:border-[#ff343c] hover:bg-[#383838] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8a00]"><span className="flex items-center gap-3"><UserRoundPlus className="h-5 w-5 text-[#ff343c]" /> Sign Up</span><ArrowRight className="h-4 w-4" /></Link>
        <button type="button" className="flex w-full items-center justify-between rounded-md bg-[#ff343c] px-4 py-4 font-semibold text-white transition hover:bg-[#e52a32] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8a00] disabled:opacity-50" disabled={enteringGuest} onClick={() => void continueAsGuest()}><span>{enteringGuest ? "Opening Guest workspace…" : "Continue as Guest"}</span><ArrowRight className="h-4 w-4" /></button>
      </div>
      {guestError && <AccessError message={guestError} />}
      <p className="mt-6 text-sm leading-6 text-[#b7b7b7]">Your installed applications, history, and preferences remain on this computer in every access mode.</p>
    </>}
  </AccessLayout>;
}
