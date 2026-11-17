"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Boxes, CircleArrowUp, Clock3, Download, Menu, Minus, ScanSearch, Settings2, Square, UserRound, X } from "lucide-react";
import type { DashboardDto } from "@updatepilot/contracts";
import { useAuth } from "./AuthProvider";
import { useLiveQuery } from "./useLiveQuery";

const navigation = [
  { href: "/overview", label: "Scan", icon: ScanSearch },
  { href: "/applications", label: "Applications", icon: Boxes },
  { href: "/updates", label: "Updates", icon: CircleArrowUp },
  { href: "/downloads", label: "Downloads", icon: Download },
  { href: "/history", label: "History", icon: Clock3 },
  { href: "/settings", label: "Settings", icon: Settings2 },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { state, loading, error, errorCode, refresh, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(false);

  useEffect(() => { if (!loading && state && !state.authenticated) router.replace("/login"); }, [loading, state, router]);
  useEffect(() => {
    setDesktop(Boolean(window.updatePilotDesktop));
  }, []);
  useEffect(() => { setMenuOpen(false); setAccountOpen(false); }, [pathname]);
  useEffect(() => {
    if (!accountOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setAccountOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accountOpen]);

  if (loading || (!state && !error)) return <div className="desktop-connecting" role="status"><Image src="/branding/UpdateX_Logo.png" alt="UpdateX" width={240} height={160} className="desktop-splash-logo" priority /><span className="loading-dot" /> Connecting to UpdateX…</div>;
  if (error) return <div className="desktop-connecting"><Image src="/branding/UpdateX_Logo.png" alt="UpdateX" width={240} height={160} className="desktop-splash-logo" /><div className="text-center"><h1 className="text-xl font-semibold">{errorCode === "LICENSE_REQUIRED" ? "Activate UpdateX" : "Local service unavailable"}</h1><p className="mt-2 text-sm text-[#aaa]">{error}</p><div className="mt-4 flex justify-center gap-3">{errorCode === "LICENSE_REQUIRED" && <Link className="button-primary" href="/activate">Enter license key</Link>}<button className="button-secondary" onClick={() => void refresh()}>Try again</button></div></div></div>;
  if (!state?.authenticated) return null;

  const page = navigation.find(item => pathname.startsWith(item.href)) ?? navigation[0];
  const isScan = pathname.startsWith("/overview");

  async function handleSignOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
      window.sessionStorage.removeItem("updatepilot.active-scan-id");
      router.replace("/login");
    } catch (cause) {
      setSignOutError(cause instanceof Error ? cause.message : "Could not sign out.");
    } finally { setSigningOut(false); }
  }

  return <div className="desktop-shell">
    <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[80] focus:rounded focus:bg-[#ff343c] focus:px-3 focus:py-2 focus:text-white">Skip to content</a>
    <header className="desktop-titlebar">
      <div className="desktop-brand"><span className="brand-mark"><Image src="/branding/UpdateX_App_Icon.ico" alt="" width={31} height={31} className="h-[31px] w-[31px] object-contain" unoptimized /></span><span><strong>UpdateX</strong><small>Software update intelligence</small></span></div>
      <div className="desktop-title-actions">
        {state.mode === "guest" && <span className="rounded border border-[#555] px-2 py-0.5 text-[11px] font-semibold text-[#d1d1d1]">Guest</span>}
        <Link href="/settings" className="title-icon" aria-label="Open settings" title="Settings"><Settings2 className="h-[18px] w-[18px]" /></Link>
        <div className="relative">
          <button className="title-icon" aria-label={state.mode === "guest" ? "Guest access" : "Local account"} aria-expanded={accountOpen} onClick={() => setAccountOpen(value => !value)} title={state.mode === "guest" ? "Guest" : "Account"}><UserRound className="h-[18px] w-[18px]" /></button>
          {accountOpen && <div className="account-menu"><div className="border-b border-[#393939] px-4 py-3"><div className="text-sm font-semibold">{state.mode === "guest" ? "Guest" : state.username}</div><div className="mt-0.5 text-xs text-[#aaa]">{state.mode === "guest" ? "Full local access · no account" : "Local account"}</div></div>{state.mode === "guest" && <><Link className="block px-4 py-3 text-sm hover:bg-[#393939]" href="/sign-in">Sign In</Link><Link className="block px-4 py-3 text-sm hover:bg-[#393939]" href="/sign-up">Sign Up</Link></>}<button className="w-full px-4 py-3 text-left text-sm hover:bg-[#393939] disabled:opacity-50" disabled={signingOut} onClick={() => void handleSignOut()}>{state.mode === "guest" ? "Leave Guest mode" : "Sign Out"}</button>{signOutError && <p className="px-4 pb-3 text-xs text-[#ff777b]" role="alert">{signOutError}</p>}</div>}
        </div>
        {desktop && <div className="window-controls" aria-label="Window controls"><button aria-label="Minimize window" title="Minimize" onClick={() => void window.updatePilotDesktop?.minimize()}><Minus className="h-4 w-4" /></button><button aria-label="Maximize or restore window" title="Maximize or restore" onClick={() => void window.updatePilotDesktop?.toggleMaximize()}><Square className="h-3.5 w-3.5" /></button><button className="close-window" aria-label="Close window" title="Close" onClick={() => void window.updatePilotDesktop?.close()}><X className="h-4 w-4" /></button></div>}
      </div>
    </header>
    <div className="desktop-body">
      <aside className={`desktop-sidebar ${menuOpen ? "sidebar-open" : ""}`} aria-label="Main navigation">
        <nav className="desktop-nav" aria-label="Primary">
          {navigation.map(item => { const Icon = item.icon; const active = pathname.startsWith(item.href); return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`desktop-nav-item ${active ? "active" : ""}`} title={item.label}><Icon className="h-5 w-5" strokeWidth={active ? 2.5 : 2} /><span>{item.label}</span>{item.href === "/updates" && <UpdateNavCount />}</Link>; })}
        </nav>
      </aside>
      <div className="desktop-workspace">
        <button className="mobile-menu-button" aria-label={menuOpen ? "Close navigation" : "Open navigation"} onClick={() => setMenuOpen(value => !value)}>{menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
        <main id="main-content" className={isScan ? "desktop-main desktop-main-scan" : "desktop-main desktop-main-results"}>{children}</main>
      </div>
    </div>
    <ShellStatus pageLabel={page.label} />
  </div>;
}

function UpdateNavCount() {
  const { data } = useLiveQuery<DashboardDto>("/dashboard");
  return data?.updateCount ? <span className="nav-count">{data.updateCount}</span> : null;
}

function ShellStatus({ pageLabel }: { pageLabel: string }) {
  const { data, reload } = useLiveQuery<DashboardDto>("/dashboard");
  useEffect(() => { const timer = window.setInterval(reload, 10000); return () => window.clearInterval(timer); }, [reload]);
  const agent = data?.agent;
  return <footer className="desktop-statusbar"><div className="flex min-w-0 items-center gap-2"><span className={`status-dot ${agent?.connection === "online" ? "online" : ""}`} /><span className="truncate">{agent?.name ?? "No agent paired"}</span><span className="text-[#aaa]">{agent?.connection ?? "unpaired"}</span></div><div className="flex items-center gap-3"><span className="hidden sm:inline">{pageLabel}</span><span>v0.1.0</span></div></footer>;
}
