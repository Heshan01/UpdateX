using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace UpdatePilot.Agent;

// Resolves evidence before persistence. The dashboard receives one row per installation,
// while each raw registry/WinGet observation remains attached for diagnosis.
internal static class InventoryResolver
{
    private sealed class RegistryGroup(RegistryObservation first)
    {
        public List<RegistryObservation> Registry { get; } = [first];
        public List<(WinGetStructuredPackage Package, string SourceKey)> WinGet { get; } = [];
        public List<WindowsAppPackage> WindowsApps { get; } = [];
        public RegistryObservation Primary => Registry.OrderByDescending(item => item.Publisher is not null)
            .ThenByDescending(item => item.InstalledVersion is not null)
            .ThenByDescending(item => item.InstallLocation is not null)
            .ThenByDescending(item => item.WindowsInstaller).First();
        public string Scope => Primary.Hive == "CurrentUser" ? "user" : "machine";
        public string InstallationType => WindowsApps.Count > 0 ? "windows_app" : Registry.Any(IsWebApp) ? "web_app" : "desktop";
        public string? Architecture => Registry.Select(ArchitectureOf).FirstOrDefault(value => value is not null);
        public string? InstallLocation => Registry.Select(item => item.InstallLocation).FirstOrDefault(value => value is not null);
    }

    public static IReadOnlyList<ScanApplication> Resolve(
        IReadOnlyList<RegistryObservation> registry,
        IReadOnlyList<WinGetStructuredPackage> packages,
        bool structured,
        bool sourceUnavailable = false,
        IReadOnlyList<WindowsAppPackage>? windowsApps = null)
    {
        var groups = registry.Select(item => new RegistryGroup(item)).ToList();
        MergeRegistry(groups, Mirror);
        MergeRegistry(groups, StrongSameInstallation);
        // A single MSI/non-MSI pair with the same label is not installation identity.
        // Keep it separate unless a path or icon proves the same installation above.

        var synthetic = new List<ScanApplication>();
        var validPackages = packages.Where(item => !string.IsNullOrWhiteSpace(item.PackageId) &&
            !string.IsNullOrWhiteSpace(item.DisplayName) &&
            Regex.IsMatch(item.PackageId, @"^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$") &&
            item.DisplayName.Length <= 256).ToList();
        var packageCounts = validPackages.GroupBy(item => item.PackageId, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.Count(), StringComparer.OrdinalIgnoreCase);
        var sortedPackages = validPackages.Select((package, index) => (package, index))
            .OrderBy(pair => pair.package.PackageId, StringComparer.OrdinalIgnoreCase)
            .ThenBy(pair => pair.package.InstalledVersion, StringComparer.OrdinalIgnoreCase)
            .ThenBy(pair => pair.index).ToList();

        foreach (var (package, originalIndex) in sortedPackages)
        {
            string sourceKey = Hash($"winget:{package.PackageId}:{package.InstalledVersion}:{originalIndex}");
            var candidates = groups.Where(group => CanCorrelate(group, package)).ToList();
            if (candidates.Count == 1)
                candidates[0].WinGet.Add((package, sourceKey));
            else
                synthetic.Add(WinGetOnly(package, sourceKey, candidates.Count));
        }

        var storeApps = (windowsApps ?? []).Where(item =>
            !string.IsNullOrWhiteSpace(item.Name) && !string.IsNullOrWhiteSpace(item.PackageFamilyName) &&
            !string.IsNullOrWhiteSpace(item.Version) && item.Name.Length <= 256 &&
            item.Version.Length <= 128 && item.PackageFamilyName.Length <= 512 &&
            (item.Publisher?.Length ?? 0) <= 256).GroupBy(item =>
            $"{item.PackageFamilyName}:{item.Version}:{item.Architecture}", StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First()).Where(item => {
                var correlated = groups.Where(group => group.Scope == "user" &&
                    string.Equals(group.Primary.InstalledVersion, item.Version, StringComparison.OrdinalIgnoreCase) &&
                    group.Registry.Any(reg => string.Equals(reg.Key, item.PackageFamilyName, StringComparison.OrdinalIgnoreCase) ||
                        reg.Key.StartsWith(item.PackageFamilyName + "_", StringComparison.OrdinalIgnoreCase))).ToList();
                if (correlated.Count != 1) return true;
                correlated[0].WindowsApps.Add(item);
                return false;
            }).Select(StoreOnly).ToList();
        return groups.Select(group => BuildRegistryApplication(group, structured, sourceUnavailable,
                packageCounts)).Concat(synthetic).Concat(storeApps)
            .OrderBy(item => item.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(item => item.InstalledVersion, StringComparer.OrdinalIgnoreCase)
            .ThenBy(item => item.StableKey, StringComparer.Ordinal).ToList();
    }

    private static void MergeRegistry(List<RegistryGroup> groups,
        Func<RegistryGroup, RegistryGroup, bool> canMerge)
    {
        bool merged;
        do
        {
            merged = false;
            for (int i = 0; i < groups.Count && !merged; i++)
            for (int j = i + 1; j < groups.Count; j++)
            {
                if (!canMerge(groups[i], groups[j])) continue;
                groups[i].Registry.AddRange(groups[j].Registry);
                groups.RemoveAt(j);
                merged = true;
                break;
            }
        } while (merged);
    }

    private static bool Mirror(RegistryGroup left, RegistryGroup right) =>
        Compatible(left, right) && left.Registry.Any(a => right.Registry.Any(b =>
            a.Hive == b.Hive && a.View != b.View &&
            string.Equals(a.Key, b.Key, StringComparison.OrdinalIgnoreCase) &&
            (NormalizePath(a.InstallLocation) is { } location && location == NormalizePath(b.InstallLocation) ||
             NormalizePath(a.DisplayIcon) is { } icon && icon == NormalizePath(b.DisplayIcon) ||
             a.UninstallString is not null &&
                 string.Equals(a.UninstallString, b.UninstallString, StringComparison.OrdinalIgnoreCase)))) &&
        !ConflictingLocation(left, right);

    private static bool StrongSameInstallation(RegistryGroup left, RegistryGroup right)
    {
        if (!Compatible(left, right) || ConflictingLocation(left, right)) return false;
        string? leftLocation = NormalizePath(left.InstallLocation);
        string? rightLocation = NormalizePath(right.InstallLocation);
        if (leftLocation is not null && leftLocation == rightLocation) return true;
        return left.Registry.Any(a => right.Registry.Any(b =>
            NormalizePath(a.DisplayIcon) is { } icon && icon == NormalizePath(b.DisplayIcon)));
    }

    private static void MergeUniqueInstallerPairs(List<RegistryGroup> groups)
    {
        for (int i = 0; i < groups.Count; i++)
        {
            int[] candidates = Enumerable.Range(0, groups.Count).Where(j => j != i &&
                InstallerPair(groups[i], groups[j])).ToArray();
            if (candidates.Length != 1) continue;
            int j = candidates[0];
            if (Enumerable.Range(0, groups.Count).Count(k => k != j &&
                InstallerPair(groups[j], groups[k])) != 1) continue;
            groups[i].Registry.AddRange(groups[j].Registry);
            groups.RemoveAt(j);
            if (j < i) i--;
        }
    }

    private static bool InstallerPair(RegistryGroup left, RegistryGroup right) =>
        Compatible(left, right) && !ConflictingLocation(left, right) &&
        left.Primary.Publisher is not null && right.Primary.Publisher is not null &&
        left.Registry.All(item => item.WindowsInstaller) != right.Registry.All(item => item.WindowsInstaller) &&
        left.Registry.All(item => item.WindowsInstaller == left.Registry[0].WindowsInstaller) &&
        right.Registry.All(item => item.WindowsInstaller == right.Registry[0].WindowsInstaller);

    private static bool Compatible(RegistryGroup left, RegistryGroup right)
    {
        if (left.Scope != right.Scope || left.InstallationType != right.InstallationType ||
            Normalize(left.Primary.DisplayName) != Normalize(right.Primary.DisplayName)) return false;
        var versions = left.Registry.Concat(right.Registry).Select(item => item.InstalledVersion)
            .Where(value => value is not null).Distinct(StringComparer.OrdinalIgnoreCase);
        if (versions.Skip(1).Any()) return false;
        var publishers = left.Registry.Concat(right.Registry).Select(item => PublisherKey(item.Publisher))
            .Where(value => value is not null).Distinct(StringComparer.Ordinal);
        if (publishers.Skip(1).Any()) return false;
        var architectures = left.Registry.Concat(right.Registry).Select(ArchitectureOf)
            .Where(value => value is not null).Distinct(StringComparer.Ordinal);
        return !architectures.Skip(1).Any();
    }

    private static bool ConflictingLocation(RegistryGroup left, RegistryGroup right) =>
        NormalizePath(left.InstallLocation) is { } a &&
        NormalizePath(right.InstallLocation) is { } b && a != b;

    private static bool CanCorrelate(RegistryGroup group, WinGetStructuredPackage package)
    {
        if (group.InstallationType == "web_app" || string.IsNullOrWhiteSpace(package.InstalledVersion) ||
            !string.Equals(group.Primary.InstalledVersion, package.InstalledVersion,
                StringComparison.OrdinalIgnoreCase) ||
            !NameMatches(group.Primary.DisplayName, package.DisplayName, package.InstalledVersion)) return false;
        string? installedChannel = ChannelOf(group.Primary.DisplayName);
        string? packageChannel = ChannelOf(package.DisplayName + " " + package.PackageId);
        if (installedChannel is not null && installedChannel != packageChannel) return false;
        string? packagePublisher = PublisherKey(package.Publisher);
        if (packagePublisher is not null && PublisherKey(group.Primary.Publisher) != packagePublisher) return false;
        string? packageArchitecture = NormalizeArchitecture(package.Architecture);
        return packageArchitecture is null || group.Architecture is null ||
            packageArchitecture == group.Architecture;
    }

    private static bool NameMatches(string installedName, string packageName, string version)
    {
        string installed = StripQualifiers(installedName);
        string catalog = StripQualifiers(packageName);
        if (Normalize(installed) == Normalize(catalog)) return true;
        var variants = new List<string> { version };
        string trimmed = version;
        while (trimmed.EndsWith(".0", StringComparison.Ordinal))
        {
            trimmed = trimmed[..^2];
            variants.Add(trimmed);
        }
        foreach (string variant in variants)
        {
            if (!installed.EndsWith(variant, StringComparison.OrdinalIgnoreCase) ||
                installed.Length <= variant.Length) continue;
            string baseName = installed[..^variant.Length].TrimEnd(' ', '-', '_', '.');
            if (Normalize(baseName) == Normalize(catalog)) return true;
            string major = variant.Split('.')[0];
            if (catalog.EndsWith(major, StringComparison.OrdinalIgnoreCase) &&
                catalog.Length > major.Length &&
                Normalize(baseName) == Normalize(catalog[..^major.Length])) return true;
        }
        return false;
    }

    private static string? ChannelOf(string value)
    {
        var match = Regex.Match(value, @"(?<![A-Za-z])(alpha|beta|preview|canary|nightly|insider|stable|dev)(?![A-Za-z])",
            RegexOptions.IgnoreCase);
        return match.Success ? match.Value.ToLowerInvariant() : null;
    }

    private static ScanApplication BuildRegistryApplication(RegistryGroup group, bool structured,
        bool sourceUnavailable, IReadOnlyDictionary<string, int> packageCounts)
    {
        RegistryObservation primary = group.Primary;
        var observations = group.Registry.Select(RegistryEvidence)
            .Concat(group.WinGet.Select(pair => WinGetEvidence(pair.Package, pair.SourceKey)))
            .Concat(group.WindowsApps.Select(StoreEvidence))
            .OrderBy(item => item.SourceKey, StringComparer.Ordinal).ToList();
        string stable = Hash("registry-logical:" + string.Join('|', group.Registry.Select(item =>
            $"{item.Hive}:{item.View}:{item.Key}".ToLowerInvariant())
            .OrderBy(value => value, StringComparer.Ordinal)));
        string? packageId = null, target = null, source = null;
        string match = "unmatched", update = primary.InstalledVersion is null ? "unknown_version" : "no_verified_match";
        string reason = "No trusted WinGet package identity has been confirmed.";
        if (sourceUnavailable)
        {
            update = "source_unavailable";
            reason = "The WinGet catalog could not be read during this scan.";
        }
        else if (group.WinGet.Count > 0)
        {
            match = "ambiguous";
            update = "update_unknown";
            reason = "WinGet identity is correlated, but update safety evidence is incomplete or ambiguous.";
            if (group.WinGet.Select(pair => pair.Package.PackageId)
                .Distinct(StringComparer.OrdinalIgnoreCase).Count() == 1)
            {
                var package = group.WinGet[0].Package;
                packageId = package.PackageId;
                source = "winget";
                if (structured && group.WinGet.Count == 1 && packageCounts[package.PackageId] == 1 &&
                    primary.Publisher is not null && primary.InstalledVersion is not null)
                {
                    match = "verified";
                    int? comparison = CompareVersions(package.TargetVersion, primary.InstalledVersion);
                    update = !package.IsUpdateAvailable ?
                        comparison == 1 ? "blocked_or_pinned" : "up_to_date" :
                        package.TargetVersion is null ? "update_unknown" :
                        comparison == 1 ? "available" : "update_unknown";
                    if (update == "available") target = package.TargetVersion;
                    reason = update == "available"
                        ? "WinGet reports an applicable update for this uniquely correlated installation; both versions are comparable and the catalog target is newer."
                        : !package.IsUpdateAvailable ? "WinGet reports no applicable update for this exact installed package; a newer catalog version may be pinned or blocked."
                        : "WinGet reports an update, but the target is missing or its version cannot be compared safely.";
                }
            }
        }
        if (group.WindowsApps.Count > 0)
        {
            packageId = null; source = null; target = null;
            bool storeSigned = group.WindowsApps.All(item => string.Equals(item.SignatureKind, "Store", StringComparison.OrdinalIgnoreCase));
            match = "unsupported"; update = storeSigned ? "store_managed" : "unsupported_method";
            reason = storeSigned
                ? "This Store-signed Windows package is managed outside UpdateX. Check for updates in Microsoft Store, then rescan."
                : "This Windows app is not confirmed as Store-signed. UpdateX cannot safely determine its update method.";
        }
        else if (group.InstallationType == "web_app")
        {
            update = "unsupported_method";
            reason = "This browser-installed web application has no supported WinGet update method in UpdateX.";
        }
        return new(stable, primary.DisplayName, primary.Publisher, primary.InstalledVersion,
            packageId, source, target, match, update, reason, "registry", group.Scope,
            group.Architecture, group.InstallLocation, group.InstallationType, observations);
    }

    private static ScanApplication WinGetOnly(WinGetStructuredPackage package, string sourceKey,
        int candidateCount) => new(
            Hash("winget-logical:" + sourceKey), package.DisplayName, package.Publisher,
            package.InstalledVersion, package.PackageId, "winget", null,
            "ambiguous", "update_unknown", candidateCount > 1
                ? "Multiple installed records could correspond to this WinGet ID; none is eligible for update."
                : "WinGet reports an installed identity without a unique matching uninstall record.",
            "winget", null, NormalizeArchitecture(package.Architecture), null, "winget_only",
            [WinGetEvidence(package, sourceKey)]);

    private static ScanApplication StoreOnly(WindowsAppPackage item)
    {
        string key = Hash($"appx:{item.PackageFamilyName}:{item.Version}:{item.Architecture}".ToLowerInvariant());
        string? architecture = NormalizeArchitecture(item.Architecture);
        var observation = StoreEvidence(item);
        bool storeSigned = string.Equals(item.SignatureKind, "Store", StringComparison.OrdinalIgnoreCase);
        return new ScanApplication(Hash("appx-logical:" + key), item.Name,
            string.IsNullOrWhiteSpace(item.Publisher) ? null : item.Publisher,
            item.Version, null, null, null, "unsupported", storeSigned ? "store_managed" : "unsupported_method",
            storeSigned
                ? "Store-signed Windows app. Update availability is managed by Microsoft Store and is not verified by UpdateX; check in Microsoft Store, then rescan."
                : "Installed MSIX/AppX package without a confirmed Store signature. UpdateX cannot safely determine its update method.",
            "appx", "user", architecture, null, "windows_app", [observation]);
    }

    private static InventoryObservation StoreEvidence(WindowsAppPackage item) => new(
        Hash($"appx:{item.PackageFamilyName}:{item.Version}:{item.Architecture}".ToLowerInvariant()),
        "appx", item.Name, string.IsNullOrWhiteSpace(item.Publisher) ? null : item.Publisher, item.Version, null,
        null, null, null, null, null,
        NormalizeArchitecture(item.Architecture), "user", false, item.PackageFamilyName);

    private static int? CompareVersions(string? target, string? installed)
    {
        if (string.IsNullOrWhiteSpace(target) || string.IsNullOrWhiteSpace(installed) ||
            !Regex.IsMatch(target, @"^\d+(?:\.\d+){1,3}$") ||
            !Regex.IsMatch(installed, @"^\d+(?:\.\d+){1,3}$")) return null;
        string Pad(string value) => value + string.Concat(Enumerable.Repeat(".0", 4 - value.Split('.').Length));
        return Version.TryParse(Pad(target), out var a) && Version.TryParse(Pad(installed), out var b)
            ? Math.Sign(a.CompareTo(b)) : null;
    }

    private static InventoryObservation RegistryEvidence(RegistryObservation item) => new(
        Hash($"registry:{item.Hive}:{item.View}:{item.Key}".ToLowerInvariant()), "registry",
        item.DisplayName, item.Publisher, item.InstalledVersion, null,
        item.Hive, item.View, item.Key, item.InstallLocation, item.DisplayIcon,
        ArchitectureOf(item), item.Hive == "CurrentUser" ? "user" : "machine",
        item.WindowsInstaller);

    private static InventoryObservation WinGetEvidence(WinGetStructuredPackage item, string sourceKey) => new(
        sourceKey, "winget", item.DisplayName, item.Publisher, item.InstalledVersion,
        item.PackageId, null, null, null, null, null,
        NormalizeArchitecture(item.Architecture), null, null);

    private static bool IsWebApp(RegistryObservation item) =>
        item.UninstallString?.Contains("--uninstall-app-id=", StringComparison.OrdinalIgnoreCase) == true;

    private static string? ArchitectureOf(RegistryObservation item)
    {
        if (Regex.IsMatch(item.DisplayName, @"\b(64-bit|x64)\b", RegexOptions.IgnoreCase)) return "x64";
        if (Regex.IsMatch(item.DisplayName, @"\b(32-bit|x86)\b", RegexOptions.IgnoreCase)) return "x86";
        string? path = NormalizePath(item.InstallLocation);
        if (path?.Contains(@"\program files (x86)\", StringComparison.Ordinal) == true) return "x86";
        if (path?.Contains(@"\program files\", StringComparison.Ordinal) == true) return "x64";
        return null;
    }

    private static string? NormalizeArchitecture(string? value)
    {
        if (value is null) return null;
        string text = value.Trim().ToLowerInvariant();
        return text switch { "x64" or "amd64" => "x64", "x86" or "i386" => "x86",
            "arm64" => "arm64", _ => null };
    }

    private static string StripQualifiers(string value) => Regex.Replace(
        Regex.Replace(value, @"\((?:User|64-bit|32-bit|x64|x86)\)", "",
            RegexOptions.IgnoreCase), @"\((?:R|TM)\)|[®™]", "", RegexOptions.IgnoreCase).Trim();

    private static string? PublisherKey(string? value) => value is null ? null :
        Normalize(Regex.Replace(value, @"\((?:R|TM)\)|[®™]", "", RegexOptions.IgnoreCase));

    private static string Normalize(string value) => new(value.Where(char.IsLetterOrDigit)
        .Select(char.ToUpperInvariant).ToArray());

    private static string? NormalizePath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        string path = value.Trim().Trim('"');
        int iconIndex = path.LastIndexOf(',');
        if (iconIndex > 0 && int.TryParse(path[(iconIndex + 1)..], out _)) path = path[..iconIndex];
        return path.TrimEnd('\\', '/').ToLowerInvariant();
    }

    private static string Hash(string value) => Convert.ToHexStringLower(
        SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
