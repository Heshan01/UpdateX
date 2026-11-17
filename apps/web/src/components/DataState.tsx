import { AlertCircle, Inbox, LoaderCircle } from "lucide-react";

export function LoadingState({ label = "Loading live data…" }: { label?: string }) {
  return <div className="panel flex min-h-52 items-center justify-center gap-3 text-slate-500" role="status" aria-live="polite"><LoaderCircle className="h-5 w-5 animate-spin text-[#cb302f] dark:text-[#ff7771]" />{label}</div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="panel flex min-h-52 flex-col items-center justify-center px-6 text-center" role="alert"><AlertCircle className="h-8 w-8 text-rose-500" /><h2 className="mt-3 font-semibold">Could not load this view</h2><p className="mt-2 max-w-md text-sm text-slate-500 dark:text-slate-400">{message}</p>{retry && <button className="button-secondary mt-5" onClick={retry}>Try again</button>}</div>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="panel flex min-h-64 flex-col items-center justify-center px-6 text-center"><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-50 text-orange-700 dark:bg-orange-400/10 dark:text-orange-300"><Inbox className="h-7 w-7" /></div><h2 className="mt-5 text-lg font-semibold">{title}</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-500 dark:text-slate-400">{description}</p>{action && <div className="mt-5">{action}</div>}</div>;
}
