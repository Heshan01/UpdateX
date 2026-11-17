using UpdatePilot.Agent;

var tests = new (string Name, Action Test)[]
{
    ("registry and exact WinGet observation correlate", () =>
    {
        var apps = Resolve([Reg("LocalMachine", "Registry64", "Git", "Git", "2.54.0",
            "The Git Development Community", @"C:\Program Files\Git")],
            [Pkg("Git.Git", "Git", "2.54.0", "2.55.0.5", true)]);
        Check(apps.Count == 1 && apps[0].Observations.Count == 2, "one logical app with two sources");
        Check(apps[0].PackageId == "Git.Git" && apps[0].UpdateStatus == "available", "exact update retained");
        Check(apps[0].Publisher == "The Git Development Community" && apps[0].InstalledVersion == "2.54.0",
            "trusted installed metadata retained");
    }),
    ("Chrome channel ID is preserved from exact installed WinGet evidence", () =>
    {
        var apps = Resolve([Reg("LocalMachine", "Registry64", "Chrome", "Google Chrome", "156.0.8078.48",
                "Google LLC", @"C:\Program Files\Google\Chrome")],
            [Pkg("Google.Chrome.Beta.EXE", "Google Chrome", "156.0.8078.48", "157.0.8103.15", true)]);
        Check(apps.Count == 1 && apps[0].PackageId == "Google.Chrome.Beta.EXE" &&
            apps[0].AvailableVersion == "157.0.8103.15" && apps[0].UpdateStatus == "available",
            "exact Beta package evidence remains attached to the installed row");
    }),
    ("different explicit release channels never gain the other's update", () =>
    {
        var apps = Resolve([Reg("LocalMachine", "Registry64", "Beta", "Browser Beta", "1.0", "Vendor")],
            [Pkg("Vendor.Browser.Stable", "Browser Stable", "1.0", "2.0", true)]);
        Check(apps.All(item => item.UpdateStatus != "available"), "channel mismatch blocks update");
    }),
    ("same displayed name across two WinGet channels is ambiguous", () =>
    {
        var apps = Resolve([Reg("LocalMachine", "Registry64", "Browser", "Browser", "1.0", "Vendor")],
            [Pkg("Vendor.Browser.Stable", "Browser", "1.0", "2.0", true),
             Pkg("Vendor.Browser.Beta", "Browser", "1.0", "2.1", true)]);
        Check(apps.Count == 1 && apps[0].MatchStatus == "ambiguous" &&
            apps[0].UpdateStatus != "available", "two channels cannot claim the same registry installation");
    }),
    ("a catalog lookup failure keeps identity without inventing a target", () =>
    {
        var apps = Resolve([Reg("LocalMachine", "Registry64", "Editor", "Editor", "1.0", "Vendor")],
            [Pkg("Vendor.Editor", "Editor", "1.0", null!, true)]);
        Check(apps.Count == 1 && apps[0].MatchStatus == "verified" &&
            apps[0].UpdateStatus == "update_unknown" && apps[0].AvailableVersion is null,
            "partial catalog evidence cannot claim a target");
    }),
    ("Store signature distinguishes Store apps from other MSIX packages", () =>
    {
        var apps = InventoryResolver.Resolve([], [], true, windowsApps: [
            new WindowsAppPackage("Store App", "Vendor.Store_123", "1.0.0.0", "CN=Vendor", "X64", "Store"),
            new WindowsAppPackage("Sideloaded App", "Vendor.Side_456", "1.0.0.0", "CN=Vendor", "X64", "Developer")]);
        Check(apps.Count == 2 && apps.Single(item => item.DisplayName == "Store App").UpdateStatus == "store_managed" &&
            apps.Single(item => item.DisplayName == "Sideloaded App").UpdateStatus == "unsupported_method",
            "only Store-signed packages get Store actions");
    }),
    ("mirrored per-user registry views merge without losing evidence", () =>
    {
        var first = Reg("CurrentUser", "Registry64", "app-key", "ClickUp", "1.0", "Google\\Chrome",
            uninstall: "chrome.exe --uninstall-app-id=clickup");
        var apps = Resolve([first, first with { View = "Registry32" }], []);
        Check(apps.Count == 1 && apps[0].Observations.Count == 2, "mirror merged");
        Check(apps[0].InstallationType == "web_app", "browser app labelled");
    }),
    ("same product in user and machine scopes remains separate", () =>
    {
        var apps = Resolve([
            Reg("CurrentUser", "Registry64", "a", "Editor", "1.0", "Publisher"),
            Reg("LocalMachine", "Registry64", "b", "Editor", "1.0", "Publisher")], []);
        Check(apps.Count == 2, "scope preserved");
    }),
    ("different architectures remain separate", () =>
    {
        var apps = Resolve([
            Reg("LocalMachine", "Registry64", "a", "Editor (64-bit)", "1.0", "Publisher"),
            Reg("LocalMachine", "Registry32", "b", "Editor (32-bit)", "1.0", "Publisher")], []);
        Check(apps.Count == 2, "architectures preserved");
    }),
    ("machine registry views alone do not prove the same installation", () =>
    {
        var first = Reg("LocalMachine", "Registry64", "same-key", "Editor", "1.0", "Publisher");
        var apps = Resolve([first, first with { View = "Registry32" }], []);
        Check(apps.Count == 2, "different machine registry views remain separate without path evidence");
    }),
    ("different installed versions remain separate", () =>
    {
        var apps = Resolve([
            Reg("LocalMachine", "Registry64", "a", "Java Kit", "17.0", "Oracle"),
            Reg("LocalMachine", "Registry64", "b", "Java Kit", "21.0", "Oracle")], []);
        Check(apps.Count == 2, "versions preserved");
    }),
    ("same display name with different publishers remains separate", () =>
    {
        var apps = Resolve([
            Reg("LocalMachine", "Registry64", "a", "Viewer", "1.0", "Publisher A"),
            Reg("LocalMachine", "Registry64", "b", "Viewer", "1.0", "Publisher B")], []);
        Check(apps.Count == 2, "publishers preserved");
    }),
    ("same install location and matching metadata merge installer records", () =>
    {
        var apps = Resolve([
            Reg("LocalMachine", "Registry64", "msi", "Intel Rapid Storage", "14.8", "Intel Corporation",
                @"C:\Program Files\Intel\Rapid", msi: true),
            Reg("LocalMachine", "Registry64", "bundle", "Intel Rapid Storage", "14.8", "Intel Corporation",
                @"C:\Program Files\Intel\Rapid\")], []);
        Check(apps.Count == 1 && apps[0].Observations.Count == 2, "same location merged");
    }),
    ("MSI and bundle labels alone do not prove one installation", () =>
    {
        var apps = Resolve([
            Reg("LocalMachine", "Registry64", "msi", "Intel(R) Chipset Device Software", "10.1", "Intel Corporation", msi: true),
            Reg("LocalMachine", "Registry32", "bundle", "Intel(R) Chipset Device Software", "10.1", "Intel(R) Corporation")], []);
        Check(apps.Count == 2 && apps.All(item => item.Observations.Count == 1),
            "separate entries remain until path or icon evidence proves identity");
    }),
    ("publisher missing still correlates source but cannot enable update", () =>
    {
        var apps = Resolve([Reg("LocalMachine", "Registry32", "HandBrake", "HandBrake 1.11.1", "1.11.1", null)],
            [Pkg("HandBrake.HandBrake", "HandBrake", "1.11.1", "1.12.0", true)]);
        Check(apps.Count == 1 && apps[0].PackageId == "HandBrake.HandBrake", "source attached");
        Check(apps[0].MatchStatus == "ambiguous" && apps[0].UpdateStatus != "available", "not executable");
    }),
    ("ambiguous same-name candidates cannot gain an update", () =>
    {
        var apps = Resolve([
            Reg("LocalMachine", "Registry64", "a", "Viewer", "1.0", "Publisher A"),
            Reg("LocalMachine", "Registry64", "b", "Viewer", "1.0", "Publisher B")],
            [Pkg("Vendor.Viewer", "Viewer", "1.0", "2.0", true)]);
        Check(apps.Count(item => item.UpdateStatus == "available") == 0, "ambiguous update blocked");
        Check(apps.SelectMany(item => item.Observations).Select(item => item.SourceKey).Distinct().Count() == 3,
            "raw observations retained exactly once");
    }),
    ("duplicate WinGet IDs across installed versions stay non-executable", () =>
    {
        var apps = Resolve([
            Reg("LocalMachine", "Registry64", "old", "Editor", "1.0", "Publisher", @"C:\Editor-v1"),
            Reg("LocalMachine", "Registry64", "new", "Editor", "2.0", "Publisher", @"C:\Editor-v2")],
            [Pkg("Vendor.Editor", "Editor", "1.0", "3.0", true),
             Pkg("Vendor.Editor", "Editor", "2.0", "3.0", true)]);
        Check(apps.Count == 2 && apps.All(item => item.MatchStatus == "ambiguous"),
            "side-by-side installs retained without a verified update");
        Check(apps.Sum(item => item.Observations.Count) == 4, "all source observations retained");
    }),
    ("browser web app and native package remain distinct", () =>
    {
        var apps = Resolve([Reg("CurrentUser", "Registry64", "chrome-claude", "Claude", "1.0", "Google\\Chrome",
            uninstall: "chrome.exe --uninstall-app-id=claude")],
            [Pkg("Anthropic.Claude", "Claude", "1.49585.0.0", "1.50000.0.0", true)]);
        Check(apps.Count == 2 && apps.Any(item => item.InstallationType == "web_app") &&
            apps.Any(item => item.InstallationType == "winget_only"), "distinct installations preserved");
        Check(apps.All(item => item.UpdateStatus != "available"), "unresolved native package cannot update");
    }),
    ("repeated scans keep stable logical identities and no duplicate opportunity", () =>
    {
        var registry = new[] { Reg("LocalMachine", "Registry64", "Git", "Git", "2.54.0",
            "The Git Development Community", @"C:\Program Files\Git") };
        var packages = new[] { Pkg("Git.Git", "Git", "2.54.0", "2.55.0.5", true) };
        var first = Resolve(registry, packages);
        var second = Resolve(registry, packages);
        Check(first.Count == second.Count && first[0].StableKey == second[0].StableKey,
            "same logical identity on repeat");
        Check(first.Count(item => item.UpdateStatus == "available") == 1 &&
            second.Count(item => item.UpdateStatus == "available") == 1, "one opportunity per snapshot");
    }),
    ("pinned package is not an executable opportunity", () =>
    {
        var apps = Resolve([Reg("LocalMachine", "Registry64", "pin", "Editor", "1.0", "Publisher")],
            [Pkg("Vendor.Editor", "Editor", "1.0", "2.0", false)]);
        Check(apps.Count == 1 && apps[0].UpdateStatus == "blocked_or_pinned", "pinned update blocked");
    }),
    ("missing installed version remains ineligible", () =>
    {
        var apps = Resolve([Reg("LocalMachine", "Registry64", "unknown", "Editor", null, "Publisher")],
            [Pkg("Vendor.Editor", "Editor", "1.0", "2.0", true)]);
        Check(apps.All(item => item.UpdateStatus != "available"), "versionless record cannot update");
    }),
    ("WinGet source outage does not invent opportunities", () =>
    {
        var apps = InventoryResolver.Resolve(
            [Reg("LocalMachine", "Registry64", "offline", "Editor", "1.0", "Publisher")],
            [], false, true);
        Check(apps.Count == 1 && apps[0].UpdateStatus == "source_unavailable", "source outage visible");
    }),
    ("an absent WinGet identity is not an unsupported update method", () =>
    {
        var apps = Resolve([Reg("LocalMachine", "Registry64", "unknown", "Utility", "1.0", "Vendor")], []);
        Check(apps.Count == 1 && apps[0].UpdateStatus == "no_verified_match" &&
            apps[0].AvailableVersion is null, "missing identity is classified accurately");
    }),
    ("update uses only the approved exact WinGet ID and version", () =>
    {
        string[] arguments = UpdateRunner.WinGetArguments(Claim());
        Check(arguments.SequenceEqual(new[] { "upgrade", "--id", "VideoLAN.VLC", "--exact",
            "--source", "winget", "--version", "3.0.24", "--disable-interactivity" }),
            "fixed WinGet arguments without agreement, force, elevation or shell flags");
        var invalid = Claim() with { PackageId = "VideoLAN.VLC & calc.exe" };
        var outcome = Simulate(invalid, new WinGetRunResult("exited", 0), [Observed("3.0.24")]);
        Check(outcome.Result.Status == "action_required" && outcome.RunCount == 0,
            "invalid identity cannot reach the process adapter");
    }),
    ("successful WinGet exit requires a trusted post-update target version", () =>
    {
        var outcome = Simulate(Claim(), new WinGetRunResult("exited", 0), [Observed("3.0.24")]);
        Check(outcome.Result.Status == "succeeded" && outcome.Result.ObservedVersion == "3.0.24",
            "target version verified");
        Check(outcome.RunCount == 1 && outcome.VerifyCount == 1 && outcome.ScanCount == 1,
            "WinGet, verifying transition and post-update scan all ran");
    }),
    ("nonzero WinGet exit is a recorded failure, not success", () =>
    {
        var outcome = Simulate(Claim(), new WinGetRunResult("exited", 1), [Observed("3.0.23")]);
        Check(outcome.Result.Status == "failed" && outcome.Result.ExitCode == 1 &&
            outcome.Result.DiagnosticCode == "WINGET_EXIT_NONZERO", "failure classified");
        Check(outcome.VerifyCount == 0 && outcome.ScanCount == 0, "no success verification on failed exit");
    }),
    ("interrupted WinGet is uncertain and never automatically retried", () =>
    {
        var outcome = Simulate(Claim(), new WinGetRunResult("interrupted"), [Observed("3.0.23")]);
        Check(outcome.Result.Status == "execution_unknown" &&
            outcome.Result.DiagnosticCode == "AGENT_INTERRUPTED", "cancelled process is uncertain");
        Check(outcome.RunCount == 1 && outcome.ScanCount == 0, "no repeat execution");
    }),
    ("unchanged installed version after exit zero fails verification", () =>
    {
        var outcome = Simulate(Claim(), new WinGetRunResult("exited", 0), [Observed("3.0.23")]);
        Check(outcome.Result.Status == "verification_failed" &&
            outcome.Result.ObservedVersion == "3.0.23" &&
            outcome.Result.DiagnosticCode == "TARGET_VERSION_NOT_OBSERVED", "old version recorded honestly");
    }),
    ("catalog outage after WinGet exit cannot claim success", () =>
    {
        var outcome = Simulate(Claim(), new WinGetRunResult("exited", 0), [], "CATALOG_UNAVAILABLE");
        Check(outcome.Result.Status == "verification_failed" &&
            outcome.Result.DiagnosticCode == "VERIFICATION_SCAN_FAILED", "unknown post-update version");
    }),
    ("heartbeat and job result JSON matches shared TypeScript fixtures", () =>
    {
        var json = new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web);
        Fixture("agent-heartbeat.json", System.Text.Json.JsonSerializer.Serialize(new { executionMode = "read_only" }, json));
        Fixture("scan-failure.json", System.Text.Json.JsonSerializer.Serialize(new ScanResult("failed", [], 0, "SCAN_FAILED"), json));
        Fixture("update-action-required.json", System.Text.Json.JsonSerializer.Serialize(
            new UpdateResult("action_required", null, null, "PACKAGE_EVIDENCE_CHANGED", false), json));
    }),
    ("terminal download output reports actual percent and mixed-unit bytes", () =>
    {
        const string terminal = "Downloading https://example.invalid/package\r\u001b[2K 512 KB / 2 MB 25%\r";
        using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(terminal));
        using var reader = new StreamReader(stream);
        var events = new List<UpdateProgress>();
        UpdateRunner.PumpProgressAsync(reader, progress =>
        {
            events.Add(progress);
            return Task.CompletedTask;
        }, CancellationToken.None).GetAwaiter().GetResult();
        Check(events.Any(item => item.Stage == "downloading" && item.Percent == 25 &&
            item.DownloadedBytes == 512L * 1024 && item.TotalBytes == 2L * 1024 * 1024),
            "real terminal metrics are parsed without inventing progress");
    }),
};

int passed = 0;
foreach (var (name, test) in tests)
{
    try { test(); Console.WriteLine($"PASS {name}"); passed++; }
    catch (Exception error) { Console.Error.WriteLine($"FAIL {name}: {error}"); }
}
Console.WriteLine($"{passed}/{tests.Length} inventory resolver tests passed.");
return passed == tests.Length ? 0 : 1;

static RegistryObservation Reg(string hive, string view, string key, string name, string? version,
    string? publisher, string? location = null, bool msi = false, string? uninstall = null) =>
    new(hive, view, key, name, publisher, version, location, null, uninstall, msi);

static WinGetStructuredPackage Pkg(string id, string name, string installed, string target,
    bool update) => new(id, name, installed, target, update);

static IReadOnlyList<ScanApplication> Resolve(IReadOnlyList<RegistryObservation> registry,
    IReadOnlyList<WinGetStructuredPackage> packages) =>
    InventoryResolver.Resolve(registry, packages, true);

static UpdateClaim Claim() => new("job-test", "device-test", "app-test", "running",
    "VideoLAN.VLC", "winget", "3.0.23", "3.0.24", "VideoLAN", "stable-test", "hash-test",
    DateTimeOffset.UtcNow.AddMinutes(10));

static ScanApplication Observed(string version) => new("stable-test", "VLC media player", "VideoLAN",
    version, "VideoLAN.VLC", "winget", null, "verified", "up_to_date", null, "registry",
    "machine", "x86", null, "desktop", []);

static (UpdateResult Result, int RunCount, int ScanCount, int VerifyCount) Simulate(
    UpdateClaim job, WinGetRunResult run, IReadOnlyList<ScanApplication> applications,
    string? catalogError = null)
{
    int runs = 0, scans = 0, verifies = 0;
    UpdateResult result = UpdateRunner.ExecuteVerifiedAsync(job,
        (_, _) => { runs++; return Task.FromResult(run); },
        _ => { scans++; return Task.FromResult((applications, catalogError, applications.Count)); },
        _ => { verifies++; return Task.CompletedTask; }, CancellationToken.None).GetAwaiter().GetResult();
    return (result, runs, scans, verifies);
}

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static void Fixture(string name, string actual)
{
    DirectoryInfo? directory = new(AppContext.BaseDirectory);
    while (directory is not null)
    {
        string path = Path.Combine(directory.FullName, "packages", "contracts", "fixtures", name);
        if (File.Exists(path))
        {
            Check(string.Equals(File.ReadAllText(path).Trim(), actual, StringComparison.Ordinal),
                $"C# serialization differs from {name}");
            return;
        }
        directory = directory.Parent;
    }
    throw new InvalidOperationException("Shared protocol fixture not found.");
}
