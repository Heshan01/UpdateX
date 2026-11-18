using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace UpdatePilot.Agent;

internal sealed record WinGetStructuredPackage(
    string PackageId, string DisplayName, string? InstalledVersion,
    string? TargetVersion, bool IsUpdateAvailable, string? Publisher = null,
    string? Architecture = null);

internal sealed record WinGetStructuredResult(bool Available,
    IReadOnlyList<WinGetStructuredPackage> Packages, string? ErrorCode, int LookupFailures = 0);

internal sealed record WinGetScanEnvelope(
    IReadOnlyList<WinGetStructuredPackage> Packages, int LookupFailures);

internal sealed class WinGetColumnOffsets
{
    public int NameStart { get; set; } = -1;
    public int IdStart { get; set; } = -1;
    public int VersionStart { get; set; } = -1;
    public int AvailableStart { get; set; } = -1;
    public int SourceStart { get; set; } = -1;

    public bool IsValid => NameStart >= 0 && IdStart > NameStart && VersionStart > IdStart;
}

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
        // 1. Primary: Try Microsoft.WinGet.Client PowerShell module
        string? module = FindModule();
        string script = EnsureScript();
        string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

        if (module is not null && File.Exists(script) && File.Exists(powershell))
        {
            try
            {
                var moduleResult = await ReadWithPowerShellModuleAsync(powershell, script, module, token);
                if (moduleResult.Available)
                    return moduleResult;
                AgentLog.Write("winget_catalog", $"PowerShell module returned error {moduleResult.ErrorCode}; falling back to winget.exe CLI");
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                AgentLog.Write("winget_catalog", $"PowerShell module failed ({ex.Message}); falling back to winget.exe CLI");
            }
        }
        else
        {
            AgentLog.Write("winget_catalog", "PowerShell WinGet module not found; falling back to winget.exe CLI");
        }

        // 2. Fallback: Direct winget.exe CLI
        return await ReadWithCliFallbackAsync(token);
    }

    private static async Task<WinGetStructuredResult> ReadWithPowerShellModuleAsync(
        string powershell, string script, string module, CancellationToken token)
    {
        using var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = powershell,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
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

    public static async Task<WinGetStructuredResult> ReadWithCliFallbackAsync(CancellationToken token)
    {
        string? wingetPath = ResolveWinGetPath();
        if (wingetPath is null)
            return new(false, [], "WINGET_CLIENT_UNAVAILABLE");

        string? listOutput = await RunWinGetProcessAsync(wingetPath, ["list", "--accept-source-agreements"], token);
        if (listOutput is null)
            return new(false, [], "WINGET_CLIENT_FAILED");

        string? upgradeOutput = await RunWinGetProcessAsync(wingetPath, ["upgrade", "--accept-source-agreements"], token);

        var packages = ParseWinGetCliOutput(listOutput, upgradeOutput);
        return new(true, packages, null, 0);
    }

    private static async Task<string?> RunWinGetProcessAsync(string exePath, string[] args, CancellationToken token)
    {
        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = exePath,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
            };
            foreach (string arg in args)
                process.StartInfo.ArgumentList.Add(arg);

            if (!process.Start()) return null;

            Task<string> output = process.StandardOutput.ReadToEndAsync(token);
            Task<string> error = process.StandardError.ReadToEndAsync(token);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(Timeout);
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
                return null;
            }
            await Task.WhenAll(output, error);
            return output.Result;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch { return null; }
    }

    internal static string? ResolveWinGetPath()
    {
        string? configured = Environment.GetEnvironmentVariable("UPDATEX_WINGET_PATH");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
            return Path.GetFullPath(configured);

        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string appExecutionAlias = Path.Combine(localAppData, "Microsoft", "WindowsApps", "winget.exe");
        if (File.Exists(appExecutionAlias))
            return appExecutionAlias;

        string? pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrWhiteSpace(pathEnv))
        {
            foreach (string segment in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                try
                {
                    string candidate = Path.Combine(segment, "winget.exe");
                    if (File.Exists(candidate)) return Path.GetFullPath(candidate);
                }
                catch { }
            }
        }

        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string windowsApps = Path.Combine(programFiles, "WindowsApps");
        if (Directory.Exists(windowsApps))
        {
            try
            {
                var match = Directory.GetFiles(windowsApps, "winget.exe", SearchOption.AllDirectories).FirstOrDefault();
                if (match is not null) return match;
            }
            catch { }
        }

        return null;
    }

    internal static WinGetColumnOffsets? DetectColumns(string headerLine, string separatorLine)
    {
        if (string.IsNullOrWhiteSpace(separatorLine)) return null;
        string trimmedSep = separatorLine.Trim();
        if (trimmedSep.Length < 10 || !trimmedSep.Contains('-') || !trimmedSep.All(c => c == '-' || c == ' '))
            return null;

        var nameMatch = Regex.Match(headerLine, @"\bName\b", RegexOptions.IgnoreCase);
        var idMatch = Regex.Match(headerLine, @"\bId\b", RegexOptions.IgnoreCase);
        var versionMatch = Regex.Match(headerLine, @"\bVersion\b", RegexOptions.IgnoreCase);

        if (!nameMatch.Success || !idMatch.Success || !versionMatch.Success)
            return null;

        if (idMatch.Index <= nameMatch.Index || versionMatch.Index <= idMatch.Index)
            return null;

        var availableMatch = Regex.Match(headerLine, @"\bAvailable\b", RegexOptions.IgnoreCase);
        var sourceMatch = Regex.Match(headerLine, @"\bSource\b", RegexOptions.IgnoreCase);

        return new WinGetColumnOffsets
        {
            NameStart = nameMatch.Index,
            IdStart = idMatch.Index,
            VersionStart = versionMatch.Index,
            AvailableStart = availableMatch.Success && availableMatch.Index > versionMatch.Index ? availableMatch.Index : -1,
            SourceStart = sourceMatch.Success && sourceMatch.Index > versionMatch.Index ? sourceMatch.Index : -1
        };
    }

    private static string CleanLine(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        string cleaned = Regex.Replace(raw, @"\x1B\[[^@-~]*[@-~]", "");
        int lastCr = cleaned.LastIndexOf('\r');
        if (lastCr >= 0 && lastCr < cleaned.Length - 1)
            cleaned = cleaned.Substring(lastCr + 1);
        else
            cleaned = cleaned.Replace("\r", "");
        return cleaned;
    }

    private static string ExtractField(string line, int start, int nextStart)
    {
        if (start < 0 || start >= line.Length) return string.Empty;
        if (nextStart < 0 || nextStart > line.Length) nextStart = line.Length;
        if (nextStart <= start) return string.Empty;
        return line.Substring(start, nextStart - start).Trim();
    }

    internal static List<WinGetStructuredPackage> ParseWinGetTable(string output)
    {
        var result = new List<WinGetStructuredPackage>();
        if (string.IsNullOrWhiteSpace(output)) return result;

        string[] lines = output.Split('\n');
        WinGetColumnOffsets? offsets = null;
        int dataStartLine = -1;

        for (int i = 0; i < lines.Length - 1; i++)
        {
            string line = CleanLine(lines[i]);
            string nextLine = CleanLine(lines[i + 1]);

            offsets = DetectColumns(line, nextLine);
            if (offsets != null && offsets.IsValid)
            {
                dataStartLine = i + 2;
                break;
            }
        }

        if (offsets is null || dataStartLine < 0) return result;

        for (int i = dataStartLine; i < lines.Length; i++)
        {
            string line = CleanLine(lines[i]);
            if (string.IsNullOrWhiteSpace(line)) continue;

            string name = ExtractField(line, offsets.NameStart, offsets.IdStart);
            string id = ExtractField(line, offsets.IdStart, offsets.VersionStart);

            if (string.IsNullOrWhiteSpace(id) || !Regex.IsMatch(id, @"^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$"))
                continue;

            int versionEnd = offsets.AvailableStart > 0 ? offsets.AvailableStart : (offsets.SourceStart > 0 ? offsets.SourceStart : -1);
            string version = ExtractField(line, offsets.VersionStart, versionEnd);

            string available = offsets.AvailableStart > 0
                ? ExtractField(line, offsets.AvailableStart, offsets.SourceStart > 0 ? offsets.SourceStart : -1)
                : string.Empty;

            string source = offsets.SourceStart > 0
                ? ExtractField(line, offsets.SourceStart, -1)
                : string.Empty;

            // If a Source column was present and non-empty, ensure it's from the winget source
            if (offsets.SourceStart > 0 && !string.IsNullOrWhiteSpace(source) && !source.Equals("winget", StringComparison.OrdinalIgnoreCase))
                continue;

            string? installedVersion = string.IsNullOrWhiteSpace(version) ? null : version;
            string? targetVersion = null;
            bool isUpdateAvailable = false;

            if (!string.IsNullOrWhiteSpace(available) && !available.Equals("-", StringComparison.Ordinal) && !available.Equals(version, StringComparison.Ordinal))
            {
                targetVersion = available;
                isUpdateAvailable = true;
            }

            result.Add(new WinGetStructuredPackage(
                PackageId: id,
                DisplayName: string.IsNullOrWhiteSpace(name) ? id : name,
                InstalledVersion: installedVersion,
                TargetVersion: targetVersion,
                IsUpdateAvailable: isUpdateAvailable,
                Publisher: null,
                Architecture: null
            ));
        }

        return result;
    }

    internal static List<WinGetStructuredPackage> ParseWinGetCliOutput(string listOutput, string? upgradeOutput)
    {
        var listPackages = ParseWinGetTable(listOutput);
        var upgradePackages = !string.IsNullOrWhiteSpace(upgradeOutput)
            ? ParseWinGetTable(upgradeOutput)
            : [];

        var upgradeMap = new Dictionary<string, WinGetStructuredPackage>(StringComparer.OrdinalIgnoreCase);
        foreach (var up in upgradePackages)
        {
            upgradeMap[up.PackageId] = up;
        }

        var result = new List<WinGetStructuredPackage>();
        var seenIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var pkg in listPackages)
        {
            if (upgradeMap.TryGetValue(pkg.PackageId, out var up))
            {
                result.Add(pkg with
                {
                    IsUpdateAvailable = true,
                    TargetVersion = up.TargetVersion ?? pkg.TargetVersion,
                    InstalledVersion = pkg.InstalledVersion ?? up.InstalledVersion
                });
            }
            else
            {
                result.Add(pkg);
            }
            seenIds.Add(pkg.PackageId);
        }

        // Add any upgradeable packages discovered by winget upgrade that were not in list
        foreach (var up in upgradePackages)
        {
            if (!seenIds.Contains(up.PackageId))
            {
                result.Add(up with { IsUpdateAvailable = true });
                seenIds.Add(up.PackageId);
            }
        }

        return result;
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
