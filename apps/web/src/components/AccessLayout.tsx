"use client";

import Image from "next/image";
import { LockKeyhole, ShieldCheck } from "lucide-react";

export function AccessLayout({ eyebrow, title, description, children }: {
  eyebrow: string; title: string; description: string; children: React.ReactNode;
}) {
  return <div className="grid min-h-screen bg-[#242424] text-[#f5f5f5] lg:grid-cols-2">
    <aside className="relative hidden overflow-hidden border-r border-[#373737] bg-[#141414] px-12 py-10 lg:flex lg:flex-col">
      <div className="absolute -right-24 top-16 h-80 w-80 rounded-full bg-[#ff343c]/10 blur-3xl" aria-hidden="true" />
      <Image src="/branding/UpdateX_Logo.png" alt="UpdateX logo" width={300} height={200} className="relative h-auto w-[min(100%,300px)] object-contain" priority />
      <div className="relative my-auto max-w-xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#ff8a00]">Software update intelligence</p>
        <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight">Know what is installed.<br /><span className="text-[#ff8a00]">Update with confidence.</span></h1>
        <p className="mt-6 max-w-md text-sm leading-7 text-[#bdbdbd]">A local workspace for clear software inventory, trustworthy update information, and verified outcomes.</p>
        <div className="mt-10 flex max-w-md gap-6 border-t border-[#343434] pt-6 text-sm text-[#c9c9c9]"><span className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-[#ff343c]" /> Explicit approval</span><span className="flex items-center gap-2"><LockKeyhole className="h-5 w-5 text-[#ff8a00]" /> Local operation</span></div>
      </div>
      <p className="relative text-xs text-[#8f8f8f]">UpdateX · Windows software intelligence</p>
    </aside>
    <main className="flex min-h-screen items-center justify-center px-6 py-12 sm:px-12">
      <div className="w-full max-w-[410px]">
        <Image src="/branding/UpdateX_Logo.png" alt="UpdateX logo" width={180} height={120} className="mb-8 h-auto w-[180px] object-contain lg:hidden" priority />
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#ff8a00]">{eyebrow}</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-3 text-sm leading-6 text-[#b7b7b7]">{description}</p>
        {children}
        <p className="mt-9 flex items-start gap-2 text-xs leading-5 text-[#9b9b9b]"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />Your license and account are checked locally. Keep your password private.</p>
      </div>
    </main>
  </div>;
}

export function AccessError({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="mt-6 rounded-lg border border-[#ff343c]/40 bg-[#ff343c]/10 p-4 text-sm text-[#ffb8bb]" role="alert">
    <p>{message}</p>{retry && <button className="mt-2 font-semibold underline" onClick={retry}>Try again</button>}
  </div>;
}
