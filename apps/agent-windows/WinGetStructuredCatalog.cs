using System.Diagnostics;
using System.Reflection;
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
            string tempDir = Path.Combine(Path.GetTempPath(), "UpdateX");
            Directory.CreateDirectory(tempDir);
            string tempScript = Path.Combine(tempDir, "ReadWinGet.ps1");
            var assembly = Assembly.GetExecutingAssembly();
            string? resourceName = assembly.GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith("ReadWinGet.ps1", StringComparison.OrdinalIgnoreCase));
            if (resourceName is not null)
            {
                using var stream = assembly.GetManifestResourceStream(resourceName);
                if (stream is not null)
                {
                    using var file = new FileStream(tempScript, FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
                    stream.CopyTo(file);
                    return tempScript;
                }
            }
            if (File.Exists(tempScript)) return tempScript;
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
            foreach (string argument in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ModulePath", module })
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
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return Path.GetFullPath(configured);
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            foreach (string relative in new[] {
                Path.Combine("modules", "Microsoft.WinGet.Client", "1.29.380", "Microsoft.WinGet.Client.psd1"),
                Path.Combine(".local", "modules", "Microsoft.WinGet.Client", "1.29.380", "Microsoft.WinGet.Client.psd1"),
                Path.Combine("resources", "services", "agent", "modules", "Microsoft.WinGet.Client", "1.29.380", "Microsoft.WinGet.Client.psd1"),
            })
            {
                string path = Path.Combine(directory.FullName, relative);
                if (File.Exists(path)) return Path.GetFullPath(path);
            }
        }
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidates = [
            Path.Combine(localAppData, "Programs", "@updatepilotdesktop-shell", "UpdateX", "resources", "services", "agent", "modules", "Microsoft.WinGet.Client", "1.29.380", "Microsoft.WinGet.Client.psd1"),
            Path.Combine(localAppData, "Microsoft", "WinGet", "Modules", "Microsoft.WinGet.Client", "Microsoft.WinGet.Client.psd1"),
            Path.Combine(Path.GetTempPath(), "UpdateX", "modules", "Microsoft.WinGet.Client", "1.29.380", "Microsoft.WinGet.Client.psd1"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WindowsPowerShell", "Modules", "Microsoft.WinGet.Client", "Microsoft.WinGet.Client.psd1"),
        ];
        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate)) return Path.GetFullPath(candidate);
        }
        return null;
    }
}
