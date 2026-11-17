import { describe, expect, it, vi } from "vitest";
import { csv } from "../src/csv";
import { officialReleaseInfo } from "../src/releaseInfo";

describe("CSV export", () => {
  it("quotes fields and prevents spreadsheet formula execution", () => {
    expect(csv([["Application", "Version"], ["Editor, Pro", "1.0"], ["=HYPERLINK(\"https://bad.example\")", null]]))
      .toContain('"\'=HYPERLINK(""https://bad.example"")"');
    expect(csv([["a\nb", "x"]])).toContain('"a\nb"');
  });
});

describe("official release information", () => {
  it("rejects packages outside the verified official-source list", async () => {
    const fetcher = vi.fn();
    expect(await officialReleaseInfo("Unknown.Package", "1.0", fetcher as unknown as typeof fetch)).toMatchObject({ status: "unavailable", notes: null, officialUrl: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns only an exact published release from the official repository", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      tag_name: "v99.1", html_url: "https://github.com/obsproject/obs-studio/releases/tag/v99.1",
      published_at: "2026-10-01T00:00:00Z", body: "Official notes", draft: false,
    }) });
    const result = await officialReleaseInfo("OBSProject.OBSStudio", "99.1", fetcher as unknown as typeof fetch);
    expect(result).toMatchObject({ status: "available", version: "99.1", notes: "Official notes", source: "GitHub · obsproject/obs-studio" });
  });

  it("does not trust a mismatched URL or missing release", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      tag_name: "v98.2", html_url: "https://other.example/release", published_at: "2026-10-01T00:00:00Z", body: "Untrusted",
    }) });
    const result = await officialReleaseInfo("OBSProject.OBSStudio", "98.2", fetcher as unknown as typeof fetch);
    expect(result.status).toBe("unavailable");
    expect(result.notes).toBeNull();
  });
});
