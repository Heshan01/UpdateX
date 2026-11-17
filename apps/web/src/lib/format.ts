export function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function labelStatus(value: string): string {
  const labels: Record<string, string> = {
    store_managed: "Microsoft Store managed",
    no_verified_match: "No verified package match",
    unsupported_method: "Unsupported update method",
    update_unknown: "Update status unknown",
    source_unavailable: "WinGet unavailable",
  };
  if (labels[value]) return labels[value];
  return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}
