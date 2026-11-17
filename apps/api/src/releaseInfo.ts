export type ReleaseInfo = {
  status: "available" | "unavailable";
  version: string;
  releaseDate: string | null;
  notes: string | null;
  officialUrl: string | null;
  source: string | null;
};

// Only repositories whose ownership and package identity have been checked are listed.
const officialRepositories: Record<string, string> = {
  "OBSProject.OBSStudio": "obsproject/obs-studio",
  "Telegram.TelegramDesktop": "telegramdesktop/tdesktop",
  "Git.Git": "git-for-windows/git",
};
const cache = new Map<string, { expiresAt: number; value: ReleaseInfo }>();

export async function officialReleaseInfo(packageId: string, version: string, fetcher: typeof fetch = fetch): Promise<ReleaseInfo> {
  const unavailable: ReleaseInfo = { status: "unavailable", version, releaseDate: null, notes: null, officialUrl: null, source: null };
  const repository = officialRepositories[packageId];
  if (!repository || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version)) return unavailable;
  const key = `${packageId}:${version}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  for (const tag of [`v${version}`, version]) {
    try {
      const response = await fetcher(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "UpdateX-local-app" },
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) continue;
      const release = await response.json() as { tag_name?: string; html_url?: string; published_at?: string; body?: string; draft?: boolean };
      const url = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
      if (release.draft || release.tag_name !== tag || release.html_url !== url ||
          !release.published_at || Number.isNaN(Date.parse(release.published_at))) continue;
      const value: ReleaseInfo = {
        status: "available", version, releaseDate: release.published_at,
        notes: release.body?.trim().slice(0, 8000) || null,
        officialUrl: url, source: `GitHub · ${repository}`,
      };
      cache.set(key, { expiresAt: Date.now() + 60 * 60_000, value });
      return value;
    } catch { /* Offline, rate limited, or unavailable: do not invent metadata. */ }
  }
  cache.set(key, { expiresAt: Date.now() + 5 * 60_000, value: unavailable });
  return unavailable;
}
