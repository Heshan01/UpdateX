using System.Diagnostics;
using System.Text.Json;

namespace UpdatePilot.Agent;

internal sealed record WinGetExport(bool Available, IReadOnlyList<WinGetPackage> Packages, string? ErrorCode);

internal static class WinGetCatalog
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(2);

    public static async Task<WinGetExport> ExportInstalledAsync(CancellationToken token)
    {
        string winget = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Microsoft", "WindowsApps", "winget.exe");
        if (!File.Exists(winget)) return new(false, [], "WINGET_UNAVAILABLE");
        string outputPath = Path.Combine(Path.GetTempPath(), $"updatepilot-export-{Guid.NewGuid():N}.json");
        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = winget, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
            };
            foreach (string argument in new[] { "export", "--output", outputPath, "--source", "winget", "--include-versions" })
                process.StartInfo.ArgumentList.Add(argument);
            if (!process.Start()) return new(false, [], "WINGET_START_FAILED");
            Task<string> stdout = process.StandardOutput.ReadToEndAsync(token);
            Task<string> stderr = process.StandardError.ReadToEndAsync(token);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(Timeout);
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
                return new(false, [], "WINGET_TIMEOUT");
            }
            await Task.WhenAll(stdout, stderr);
            if (process.ExitCode != 0 || !File.Exists(outputPath)) return new(false, [], "WINGET_EXPORT_FAILED");
            using var document = JsonDocument.Parse(await File.ReadAllTextAsync(outputPath, token));
            var records = new List<WinGetPackage>();
            if (!document.RootElement.TryGetProperty("Sources", out var sources) || sources.ValueKind != JsonValueKind.Array)
                return new(false, [], "WINGET_EXPORT_INVALID");
            foreach (var source in sources.EnumerateArray())
            {
                if (!source.TryGetProperty("SourceDetails", out var details) ||
                    !details.TryGetProperty("Name", out var name) || name.GetString() != "winget") continue;
                if (!source.TryGetProperty("Packages", out var packages) || packages.ValueKind != JsonValueKind.Array) continue;
                foreach (var package in packages.EnumerateArray())
                {
                    string? id = package.TryGetProperty("PackageIdentifier", out var field) ? field.GetString() : null;
                    string? version = package.TryGetProperty("Version", out var versionField) ? versionField.GetString() : null;
                    if (id is null || !System.Text.RegularExpressions.Regex.IsMatch(id, @"^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$")) continue;
                    if (version?.Length > 128) version = null;
                    records.Add(new(id, version));
                }
            }
            // Preserve side-by-side versions; the fallback is identity evidence only and
            // must never turn a collapsed ID into an executable update.
            return new(true, records, null);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch { return new(false, [], "WINGET_EXPORT_FAILED"); }
        finally { try { File.Delete(outputPath); } catch { /* Temporary scan data expires with the OS. */ } }
    }
}
