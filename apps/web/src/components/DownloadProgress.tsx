type DownloadProgressProps = {
  applicationName: string;
  percent: number | null | undefined;
  downloadedBytes: number | null | undefined;
  totalBytes: number | null | undefined;
};

function transferSize(value: number): string {
  return `${(value / 1048576).toFixed(1)} MB`;
}

export function DownloadProgress({ applicationName, percent, downloadedBytes, totalBytes }: DownloadProgressProps) {
  const validBytes = downloadedBytes != null && totalBytes != null &&
    Number.isFinite(downloadedBytes) && Number.isFinite(totalBytes) &&
    downloadedBytes >= 0 && totalBytes > 0 && downloadedBytes <= totalBytes;
  const measuredPercent = percent != null && Number.isInteger(percent) && percent >= 0 && percent <= 100
    ? percent : validBytes ? Math.floor(downloadedBytes / totalBytes * 100) : null;

  return <div className="updatex-download-meter" role="status" aria-live="polite">
    <div className="updatex-download-meter-label">
      <span>{validBytes ? `${transferSize(downloadedBytes)} / ${transferSize(totalBytes)}` : "Downloading with WinGet"}</span>
      <strong>{measuredPercent === null ? "WinGet has not reported a percentage" : `${measuredPercent}%`}</strong>
    </div>
    {measuredPercent === null
      ? <div className="updatex-download-progress-indeterminate" role="progressbar"
          aria-label={`${applicationName} download in progress`} aria-valuetext="Percentage not reported by WinGet" />
      : <progress className="updatex-download-progress" max={100} value={measuredPercent}
          aria-label={`${applicationName} download progress`} />}
  </div>;
}
