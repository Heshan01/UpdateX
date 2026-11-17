using System.Diagnostics;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Globalization;

namespace UpdatePilot.Agent;

internal sealed record WinGetRunResult(string Status, int? ExitCode = null);

internal static class UpdateRunner
{
    private static readonly Regex PackageId = new(@"^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$", RegexOptions.Compiled);
    private static readonly Regex Version = new(@"^[A-Za-z0-9][A-Za-z0-9._+~()-]{0,127}$", RegexOptions.Compiled);
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(20);

    public static async Task RunAsync(AgentClient api, string jobId, CancellationToken token)
    {
        UpdateClaim job = await api.ClaimUpdateAsync(jobId, token);
        await using var lease = new LeaseKeeper(TimeSpan.FromMinutes(2), renewToken => api.RenewUpdateAsync(jobId, renewToken));
        UpdateResult? preflightFailure = await PreflightAsync(job, token);
        if (preflightFailure is not null)
        {
            await api.SubmitUpdateResultAsync(jobId, preflightFailure, token);
            Console.WriteLine($"Update {jobId} stopped before execution: {preflightFailure.DiagnosticCode}.");
            return;
        }

        // Record intent before launching WinGet. The browser never supplies a command line.
        await api.MarkUpdateStartedAsync(jobId, token);
        UpdateResult result = await ExecuteVerifiedAsync(job,
            (claim, runToken) => RunWinGetAsync(claim, progress => api.ReportUpdateProgressAsync(jobId, progress, runToken), runToken),
            InventoryScanner.ScanAsync,
            verifyToken => api.MarkUpdateVerifyingAsync(jobId, verifyToken), token);
        await api.SubmitUpdateResultAsync(jobId, result, token);
        Console.WriteLine($"Update {jobId}: {result.Status} ({result.DiagnosticCode ?? "VERSION_VERIFIED"}).");
    }

    private static bool ValidIdentity(UpdateClaim job) =>
        job.Source == "winget" && PackageId.IsMatch(job.PackageId) &&
        Version.IsMatch(job.TargetVersion) && !string.IsNullOrWhiteSpace(job.InstalledVersion) &&
        !string.IsNullOrWhiteSpace(job.Publisher);

    private static async Task<UpdateResult?> PreflightAsync(UpdateClaim job, CancellationToken token)
    {
        if (!ValidIdentity(job) || job.LeaseUntil is null || job.LeaseUntil <= DateTimeOffset.UtcNow)
            return ActionRequired("PACKAGE_IDENTITY_INVALID");
        if (new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
            return ActionRequired("ELEVATED_AGENT_NOT_ALLOWED");
        var (applications, catalogError, _) = await InventoryScanner.ScanAsync(token);
        if (catalogError is not null) return ActionRequired("CATALOG_UNAVAILABLE");
        var matched = applications.Where(item => item.StableKey == job.StableKey &&
            item.PackageId == job.PackageId && item.Source == "winget" &&
            item.Publisher == job.Publisher && item.InstalledVersion == job.InstalledVersion &&
            item.AvailableVersion == job.TargetVersion && item.MatchStatus == "verified" &&
            item.UpdateStatus == "available").ToList();
        return matched.Count == 1 ? null : ActionRequired("PACKAGE_EVIDENCE_CHANGED");
    }

    internal static string[] WinGetArguments(UpdateClaim job) =>
    [
        "upgrade", "--id", job.PackageId, "--exact", "--source", "winget",
        "--version", job.TargetVersion, "--disable-interactivity",
    ];

    // The same workflow accepts fake WinGet responses and a fake post-install scan in tests.
    internal static async Task<UpdateResult> ExecuteVerifiedAsync(UpdateClaim job,
        Func<UpdateClaim, CancellationToken, Task<WinGetRunResult>> runWinGet,
        Func<CancellationToken, Task<(IReadOnlyList<ScanApplication> Applications, string? CatalogError,
            int RawObservationCount)>> scan,
        Func<CancellationToken, Task> markVerifying,
        CancellationToken token)
    {
        if (!ValidIdentity(job)) return ActionRequired("PACKAGE_IDENTITY_INVALID");
        WinGetRunResult run = await runWinGet(job, token);
        if (run.Status == "unavailable") return new("failed", null, null, "WINGET_UNAVAILABLE", false);
        if (run.Status == "start_failed") return new("failed", null, null, "WINGET_START_FAILED", false);
        if (run.Status == "timeout") return new("execution_unknown", null, null, "WINGET_TIMEOUT", true);
        if (run.Status == "interrupted") return new("execution_unknown", null, null, "AGENT_INTERRUPTED", true);
        if (run.Status != "exited") return new("execution_unknown", null, null, "WINGET_EXECUTION_UNCERTAIN", true);
        if (run.ExitCode == 3010) return new("reboot_required", null, 3010, "REBOOT_REQUIRED", true);
        if (run.ExitCode != 0) return new("failed", null, run.ExitCode, "WINGET_EXIT_NONZERO", true);

        await markVerifying(token);
        try
        {
            var (applications, catalogError, _) = await scan(token);
            if (catalogError is not null)
                return new("verification_failed", null, 0, "VERIFICATION_SCAN_FAILED", true);
            var observed = applications.Where(item => item.StableKey == job.StableKey &&
                item.PackageId == job.PackageId && item.Source == "winget" &&
                item.Publisher == job.Publisher && item.MatchStatus == "verified").ToList();
            if (observed.Count != 1)
                return new("verification_failed", null, 0, "PACKAGE_EVIDENCE_CHANGED", true);
            if (observed[0].InstalledVersion != job.TargetVersion)
                return new("verification_failed", observed[0].InstalledVersion, 0, "TARGET_VERSION_NOT_OBSERVED", true);
            return new("succeeded", observed[0].InstalledVersion, 0, null, true);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return new("execution_unknown", null, 0, "AGENT_INTERRUPTED", true);
        }
        catch
        {
            return new("verification_failed", null, 0, "VERIFICATION_SCAN_FAILED", true);
        }
    }

    private static async Task<WinGetRunResult> RunWinGetAsync(UpdateClaim job,
        Func<UpdateProgress, Task> report, CancellationToken token)
    {
        string winget = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft", "WindowsApps", "winget.exe");
        if (!File.Exists(winget)) return new("unavailable");
        using var process = new Process();
        bool launched = false;
        process.StartInfo = new ProcessStartInfo
        {
            FileName = winget, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (string argument in WinGetArguments(job)) process.StartInfo.ArgumentList.Add(argument);
        try
        {
            if (!process.Start()) return new("start_failed");
            launched = true;
            Task output = PumpProgressAsync(process.StandardOutput, report, token);
            Task errors = DrainAsync(process.StandardError, token);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(Timeout);
            try { await process.WaitForExitAsync(timeout.Token); await Task.WhenAll(output, errors); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
                return new("timeout");
            }
            return new("exited", process.ExitCode);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            if (launched && !process.HasExited) process.Kill(entireProcessTree: true);
            return new(launched ? "interrupted" : "start_failed");
        }
        catch
        {
            if (launched && !process.HasExited) process.Kill(entireProcessTree: true);
            return new(launched ? "uncertain" : "start_failed");
        }
    }

    private static async Task DrainAsync(StreamReader reader, CancellationToken token)
    {
        char[] buffer = new char[512];
        while (await reader.ReadAsync(buffer.AsMemory(), token) > 0) { /* Never persist installer output or paths. */ }
    }

    internal static async Task PumpProgressAsync(StreamReader reader, Func<UpdateProgress, Task> report,
        CancellationToken token)
    {
        char[] buffer = new char[512];
        var line = new System.Text.StringBuilder(512);
        string stage = "";
        int? lastPercent = null;
        DateTime lastReport = DateTime.MinValue;
        async Task ParseAsync()
        {
            string text = Regex.Replace(line.ToString(), @"\x1B\[[0-9;]*[A-Za-z]", "");
            line.Clear();
            if (Regex.IsMatch(text, @"\bDownloading\b", RegexOptions.IgnoreCase)) stage = "downloading";
            if (Regex.IsMatch(text, @"\b(Starting package install|Installing|installer is running)\b", RegexOptions.IgnoreCase)) stage = "installing";
            if (stage.Length == 0) return;
            int? percent = null;
            long? downloaded = null, total = null;
            if (stage == "downloading")
            {
                var percentMatch = Regex.Match(text, @"(?<!\d)(100|[1-9]?\d)%");
                if (percentMatch.Success) percent = int.Parse(percentMatch.Groups[1].Value, CultureInfo.InvariantCulture);
                var size = Regex.Match(text, @"(?<a>\d+(?:\.\d+)?)\s*(?<aUnit>KB|MB|GB)\s*/\s*(?<b>\d+(?:\.\d+)?)\s*(?<bUnit>KB|MB|GB)\b", RegexOptions.IgnoreCase);
                if (size.Success)
                {
                    static double Factor(string unit) => unit.ToUpperInvariant() switch
                    { "KB" => 1024d, "MB" => 1024d * 1024, _ => 1024d * 1024 * 1024 };
                    double a = double.Parse(size.Groups["a"].Value, CultureInfo.InvariantCulture) * Factor(size.Groups["aUnit"].Value);
                    double b = double.Parse(size.Groups["b"].Value, CultureInfo.InvariantCulture) * Factor(size.Groups["bUnit"].Value);
                    if (b > 0 && a >= 0 && a <= b && b < long.MaxValue)
                    { downloaded = (long)a; total = (long)b; percent ??= (int)Math.Floor(a / b * 100); }
                }
            }
            if ((DateTime.UtcNow - lastReport).TotalSeconds < 2 && lastPercent == percent) return;
            try { await report(new UpdateProgress(stage, percent, downloaded, total)); }
            catch { /* A transient progress API failure must not re-run or abort the installer. */ }
            lastReport = DateTime.UtcNow;
            lastPercent = percent;
        }
        while (true)
        {
            int count = await reader.ReadAsync(buffer.AsMemory(), token);
            if (count == 0) break;
            for (int i = 0; i < count; i++)
            {
                if (buffer[i] is '\r' or '\n') { if (line.Length > 0) await ParseAsync(); }
                else if (line.Length < 512) line.Append(buffer[i]);
            }
        }
        if (line.Length > 0) await ParseAsync();
    }

    private static UpdateResult ActionRequired(string code) => new("action_required", null, null, code, false);
}
