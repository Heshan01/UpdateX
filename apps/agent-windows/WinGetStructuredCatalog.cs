using System.Diagnostics;
using System.Text.Json;

namespace UpdatePilot.Agent;

internal sealed record WinGetStructuredPackage(
    string PackageId, string DisplayName, string? InstalledVersion,
    string? TargetVersion, bool IsUpdateAvailable, string? Publisher = null,
    string? Architecture = null);

internal sealed record WinGetStructuredResult(bool Available,
    IReadOnlyList<WinGetStructuredPackage> Packages, string? ErrorCode, int LookupFailures = 0);

internal sealed record WinGetScanEnvelope(
    IReadOnlyList<WinGetStructuredPackage> Packages, int LookupFailures);

internal static class WinGetStructuredCatalog
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(2);

    private static string EnsureScript()
    {
        string script = Path.Combine(AppContext.BaseDirectory, "ReadWinGet.ps1");
        if (File.Exists(script)) return script;
        try
        {
            string tempScript = Path.Combine(Path.GetTempPath(), "UpdateX", "ReadWinGet.ps1");
            if (File.Exists(tempScript)) return tempScript;
            Directory.CreateDirectory(Path.GetDirectoryName(tempScript)!);
            using var stream = typeof(WinGetStructuredCatalog).Assembly.GetManifestResourceStream("UpdatePilot.Agent.ReadWinGet.ps1")
                ?? typeof(WinGetStructuredCatalog).Assembly.GetManifestResourceStream("UpdateX.Agent.ReadWinGet.ps1");
            if (stream is not null)
            {
                using var file = File.Create(tempScript);
                stream.CopyTo(file);
                return tempScript;
            }
        }
        catch { }
        return script;
    }

    public static async Task<WinGetStructuredResult> ReadAsync(CancellationToken token)
    {
        string? module = FindModule();
        string script = EnsureScript();
        string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (module is null || !File.Exists(script) || !File.Exists(powershell))
            return new(false, [], "WINGET_CLIENT_UNAVAILABLE");
        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = powershell, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8,
            };
            foreach (string argument in new[] { "-NoProfile", "-NonInteractive", "-File", script, "-ModulePath", module })
                process.StartInfo.ArgumentList.Add(argument);
            if (!process.Start()) return new(false, [], "WINGET_CLIENT_START_FAILED");
            Task<string> output = process.StandardOutput.ReadToEndAsync(token);
            Task<string> error = process.StandardError.ReadToEndAsync(token);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(Timeout);
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
                return new(false, [], "WINGET_CLIENT_TIMEOUT");
            }
            await Task.WhenAll(output, error);
            if (process.ExitCode != 0) return new(false, [], "WINGET_CLIENT_FAILED");
            if (output.Result.Length > 2_000_000) return new(false, [], "WINGET_CLIENT_INVALID");
            var envelope = JsonSerializer.Deserialize<WinGetScanEnvelope>(output.Result,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (envelope?.Packages is null || envelope.Packages.Count > 2000 ||
                envelope.LookupFailures < 0 || envelope.LookupFailures > 2000)
                return new(false, [], "WINGET_CLIENT_INVALID");
            return new(true, envelope.Packages, null, envelope.LookupFailures);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch { return new(false, [], "WINGET_CLIENT_FAILED"); }
    }

    private static string? FindModule()
    {
        string? configured = Environment.GetEnvironmentVariable("UPDATEPILOT_WINGET_MODULE");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            foreach (string relative in new[] {
                Path.Combine("modules", "Microsoft.WinGet.Client", "1.29.380", "Microsoft.WinGet.Client.psd1"),
                Path.Combine(".local", "modules", "Microsoft.WinGet.Client", "1.29.380", "Microsoft.WinGet.Client.psd1"),
            })
            {
                string path = Path.Combine(directory.FullName, relative);
                if (File.Exists(path)) return path;
            }
        }
        return null;
    }
}
