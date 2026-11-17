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

export default function SignUpPage() {
  const router = useRouter();
  const { state, loading, error: connectionError, refresh, accept } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => { if (state?.mode === "account" && state.authenticated) router.replace("/overview"); }, [state, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = username.trim();
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(name)) { setFormError("Use 3–40 letters, numbers, dots, underscores, or hyphens for the username."); return; }
    if (password.length < 12 || password.length > 200 || new TextEncoder().encode(password).length > 72) {
      setFormError("Use a password of at least 12 characters and at most 72 UTF-8 bytes."); return;
    }
    if (password !== confirmPassword) { setFormError("Passwords do not match."); return; }
    setSubmitting(true); setFormError(null);
    try {
      const next = await api.post<AuthState>("/auth/register", { username: name, password });
      accept(next);
      router.replace("/overview");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not create the local account.");
    } finally { setSubmitting(false); }
  }

  return <AccessLayout eyebrow="Optional local account" title="Sign Up" description="Create a username and password for this licensed computer. Your existing Guest inventory and history stay in place.">
    {loading ? <p className="mt-8 text-sm text-[#b7b7b7]" role="status">Checking your local session…</p> : connectionError ? <AccessError message={connectionError} retry={() => void refresh()} /> : <>
      <form className="mt-8 space-y-5" onSubmit={event => void submit(event)}>
        <div><label className="block text-sm font-semibold" htmlFor="sign-up-username">Username</label><input id="sign-up-username" className="auth-input mt-2" autoComplete="username" required minLength={3} maxLength={40} value={username} onChange={event => setUsername(event.target.value)} placeholder="Choose a username" /><p className="mt-1 text-xs text-[#999]">3–40 letters, numbers, dots, underscores, or hyphens.</p></div>
        <div><label className="block text-sm font-semibold" htmlFor="sign-up-password">Password</label><div className="relative mt-2"><input id="sign-up-password" type={showPassword ? "text" : "password"} className="auth-input pr-12" autoComplete="new-password" required minLength={12} maxLength={200} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" /><button type="button" className="absolute right-3 top-1/2 -translate-y-1/2 text-[#aaa] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ff8a00]" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}</button></div></div>
        <div><label className="block text-sm font-semibold" htmlFor="sign-up-confirm">Confirm Password</label><input id="sign-up-confirm" type={showPassword ? "text" : "password"} className="auth-input mt-2" autoComplete="new-password" required minLength={12} maxLength={200} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="Repeat your password" /></div>
        {formError && <AccessError message={formError} />}
        <button type="submit" disabled={submitting} className="flex w-full items-center justify-center gap-2 rounded-md bg-[#ff343c] px-4 py-3 font-semibold text-white transition hover:bg-[#e52a32] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff8a00] disabled:opacity-50">{submitting ? "Creating account…" : "Create Account"}<ArrowRight className="h-4 w-4" /></button>
      </form>
      <p className="mt-5 text-center text-sm text-[#b7b7b7]">Already have an account? <Link href="/sign-in" className="font-semibold text-[#ff8a00] hover:underline">Sign In</Link></p>
      <div className="mt-3 text-center text-sm"><GuestAccessButton /></div>
    </>}
  </AccessLayout>;
}
