using Microsoft.Win32;

namespace UpdatePilot.Agent;

internal static class InventoryScanner
{
    private const string UninstallPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";

    public static async Task<(IReadOnlyList<ScanApplication> Applications, string? CatalogError,
        int RawObservationCount)> ScanAsync(CancellationToken token)
    {
        List<RegistryObservation> registry = ReadRegistry();
        IReadOnlyList<WindowsAppPackage> windowsApps = await WindowsAppsCatalog.ReadAsync(token);
        WinGetStructuredResult structured = await WinGetStructuredCatalog.ReadAsync(token);
        if (structured.Available)
        {
            var applications = InventoryResolver.Resolve(registry, structured.Packages, true, windowsApps: windowsApps);
            AgentLog.Write("inventory_sources", $"REGISTRY_{registry.Count}_APPX_{windowsApps.Count}_WINGET_{structured.Packages.Count}_LOOKUP_FAILURES_{structured.LookupFailures}");
            AgentLog.Write("inventory_resolution", $"LOGICAL_{applications.Count}_AVAILABLE_{applications.Count(item => item.UpdateStatus == "available")}_AMBIGUOUS_{applications.Count(item => item.MatchStatus == "ambiguous")}");
            return (applications, null, applications.Sum(item => item.Observations.Count));
        }

        // The export fallback contains IDs and versions, but no trustworthy display name,
        // publisher or target. Deriving a name from an ID created duplicate rows and hid
        // catalog errors, so a failed structured read now preserves registry/AppX evidence.
        AgentLog.Write("winget_catalog", structured.ErrorCode ?? "WINGET_CLIENT_UNAVAILABLE");
        var registryOnly = InventoryResolver.Resolve(registry, [], false, true, windowsApps);
        AgentLog.Write("inventory_sources", $"REGISTRY_{registry.Count}_APPX_{windowsApps.Count}_WINGET_0");
        return (registryOnly, structured.ErrorCode,
            registryOnly.Sum(item => item.Observations.Count));
    }

    private static List<RegistryObservation> ReadRegistry()
    {
        var output = new List<RegistryObservation>();
        foreach (RegistryHive hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
        foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using RegistryKey root = RegistryKey.OpenBaseKey(hive, view);
            using RegistryKey? uninstall = root.OpenSubKey(UninstallPath);
            if (uninstall is null) continue;
            foreach (string subkeyName in uninstall.GetSubKeyNames())
            {
                try
                {
                    using RegistryKey? key = uninstall.OpenSubKey(subkeyName);
                    if (key is null) continue;
                    string? name = Clean(key.GetValue("DisplayName"), 256);
                    if (name is null) continue;
                    if (key.GetValue("SystemComponent")?.ToString() == "1" ||
                        key.GetValue("ParentKeyName") is not null ||
                        key.GetValue("ReleaseType")?.ToString() is "Update" or "Hotfix" or "Security Update") continue;
                    output.Add(new RegistryObservation(
                        hive.ToString(), view.ToString(), subkeyName, name,
                        Clean(key.GetValue("Publisher"), 256),
                        Clean(key.GetValue("DisplayVersion"), 128),
                        Clean(key.GetValue("InstallLocation"), 1024),
                        Clean(key.GetValue("DisplayIcon"), 1024),
                        Clean(key.GetValue("UninstallString"), 1024),
                        key.GetValue("WindowsInstaller")?.ToString() == "1"));
                }
                catch (UnauthorizedAccessException) { /* One unreadable uninstall key must not fail a scan. */ }
                catch (System.Security.SecurityException) { /* Preserve the readable observations. */ }
            }
        }
        return output;
    }

    private static string? Clean(object? value, int max)
    {
        string? text = value?.ToString()?.Trim();
        if (string.IsNullOrWhiteSpace(text)) return null;
        text = new string(text.Where(character => !char.IsControl(character)).ToArray());
        return text.Length > max ? text[..max] : text;
    }
}
