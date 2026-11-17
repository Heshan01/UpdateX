"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import type { AuthState } from "@updatepilot/contracts";
import { AccessError, AccessLayout } from "@/components/AccessLayout";
import { useAuth } from "@/components/AuthProvider";
import { api } from "@/lib/api";
import { GuestAccessButton } from "@/components/GuestAccessButton";

export default function SignInPage() {
  const router = useRouter();
  const { state, loading, error: connectionError, refresh, accept } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => { if (state?.mode === "account" && state.authenticated) router.replace("/overview"); }, [state, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password) { setFormError("Enter your username and password."); return; }
    setSubmitting(true); setFormError(null);
    try {
      const next = await api.post<AuthState>("/auth/session", { username: username.trim(), password });
      accept(next);
      router.replace("/overview");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not sign in.");
    } finally { setSubmitting(false); }
  }

  return <AccessLayout eyebrow="Sign In" title="Sign In" description="Sign in to your UpdateX account to view and manage your paired Windows devices.">
    {loading ? <p className="mt-8 text-sm text-[#b7b7b7]" role="status">Checking your local session…</p> : connectionError ? <AccessError message={connectionError} retry={() => void refresh()} /> : <>
      <form className="mt-8 space-y-5" onSubmit={event => void submit(event)}>
        <div><label className="block text-sm font-semibold" htmlFor="sign-in-username">Username</label><input id="sign-in-username" className="auth-input mt-2" autoComplete="username" required maxLength={40} value={username} onChange={event => setUsername(event.target.value)} placeholder="Your username" /></div>
        <div><label className="block text-sm font-semibold" htmlFor="sign-in-password">Password</label><div className="relative mt-2"><input id="sign-in-password" type={showPassword ? "text" : "password"} className="auth-input pr-12" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} placeholder="Your password" /><button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-[#aaa] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ff8a00]" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}</button></div></div>
        {formError && <AccessError message={formError} />}
        <button type="submit" disabled={submitting} className="flex w-full items-center justify-center gap-2 rounded-md bg-[#ff343c] px-4 py-3 font-semibold text-white transition hover:bg-[#e52a32] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8a00] disabled:opacity-50">{submitting ? "Signing in…" : "Sign In"}<ArrowRight className="h-4 w-4" /></button>
      </form>
      <p className="mt-5 text-center text-sm text-[#b7b7b7]">Don&apos;t have an account? <Link href="/sign-up" className="font-semibold text-[#ff8a00] hover:underline">Sign Up</Link></p>
      <div className="mt-3 text-center text-sm"><GuestAccessButton /></div>
      <p className="mt-6 text-center text-xs text-[#999]">A successful sign-in stays on this computer across restarts for up to 30 days, unless you sign out.</p>
    </>}
  </AccessLayout>;
}
