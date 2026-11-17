import { describe, expect, it } from "vitest";
import { matchesApplicationSearch, normalizedUsername, normalizeSearch } from "@updatepilot/db";

describe("provider-neutral text behavior", () => {
  it("matches Unicode case and equivalent composed forms before pagination", () => {
    const app = { displayName: "Éditeur ΔΟΚΙΜΉ", publisher: "München Software", packageId: "Example.Editor" };
    expect(matchesApplicationSearch(app, "e\u0301DITEUR")).toBe(true);
    expect(matchesApplicationSearch(app, "δοκιμή")).toBe(true);
    expect(matchesApplicationSearch(app, "MÜNCHEN")).toBe(true);
    expect(matchesApplicationSearch(app, "example.editor")).toBe(true);
    expect(matchesApplicationSearch(app, "different publisher")).toBe(false);
    expect(normalizeSearch("ＡＢＣ")).toBe("abc");
  });

  it("normalizes allowed account names without changing their display spelling", () => {
    expect(normalizedUsername("  Alice.Smith_1  ")).toBe("alice.smith_1");
    expect(normalizedUsername("ALICE.SMITH_1")).toBe(normalizedUsername("alice.smith_1"));
  });
});
