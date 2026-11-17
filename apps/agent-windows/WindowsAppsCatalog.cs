using System.Diagnostics;
using System.Text.Json;

namespace UpdatePilot.Agent;

internal sealed record WindowsAppPackage(string Name, string PackageFamilyName, string Version,
    string Publisher, string Architecture, string? SignatureKind = null);

internal static class WindowsAppsCatalog
{
    public static async Task<IReadOnlyList<WindowsAppPackage>> ReadAsync(CancellationToken token)
    {
        string script = Path.Combine(AppContext.BaseDirectory, "ReadWindowsApps.ps1");
        string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(script) || !File.Exists(powershell))
        {
            AgentLog.Write("windows_apps", "APPX_COLLECTOR_UNAVAILABLE");
            return [];
        }
        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo { FileName = powershell, UseShellExecute = false,
                CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8 };
            foreach (string arg in new[] { "-NoProfile", "-NonInteractive", "-File", script })
                process.StartInfo.ArgumentList.Add(arg);
            if (!process.Start())
            {
                AgentLog.Write("windows_apps", "APPX_START_FAILED");
                return [];
            }
            Task<string> output = process.StandardOutput.ReadToEndAsync(token);
            Task<string> error = process.StandardError.ReadToEndAsync(token);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromSeconds(45));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
                AgentLog.Write("windows_apps", "APPX_TIMEOUT");
                return [];
            }
            await Task.WhenAll(output, error);
            if (process.ExitCode != 0 || output.Result.Length > 2_000_000)
            {
                AgentLog.Write("windows_apps", "APPX_COLLECT_FAILED");
                return [];
            }
            var records = JsonSerializer.Deserialize<List<WindowsAppPackage>>(output.Result,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (records is { Count: <= 2000 })
            {
                AgentLog.Write("windows_apps", $"APPX_COUNT_{records.Count}");
                return records;
            }
            AgentLog.Write("windows_apps", "APPX_INVALID");
            return [];
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch
        {
            AgentLog.Write("windows_apps", "APPX_COLLECT_FAILED");
            return [];
        } // Store inventory is optional; never turn missing evidence into an update claim.
    }
}
