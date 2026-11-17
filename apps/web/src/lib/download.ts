export async function downloadCsv(path: string, filename: string): Promise<void> {
  const response = await fetch(`/api/v1${path}`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("Export failed. Check your session and local API connection.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
