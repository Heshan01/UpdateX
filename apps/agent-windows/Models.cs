namespace UpdatePilot.Agent;

internal sealed record AgentConfiguration(string KeyName, string? DeviceId, string? PairingId = null);
internal sealed record PairingStartResponse(string PairingId, string Code, string Fingerprint, DateTimeOffset ExpiresAt);
internal sealed record PairingStatusResponse(bool Paired, string? DeviceId);
internal sealed record NextJobResponse(string Kind, string? JobId);
internal sealed record ScanApplication(
    string StableKey, string DisplayName, string? Publisher, string? InstalledVersion,
    string? PackageId, string? Source, string? AvailableVersion, string MatchStatus,
    string UpdateStatus, string? MatchReason, string EvidenceType, string? InstallScope,
    string? Architecture, string? InstallLocation, string InstallationType,
    IReadOnlyList<InventoryObservation> Observations);
internal sealed record InventoryObservation(
    string SourceKey, string EvidenceType, string DisplayName, string? Publisher,
    string? InstalledVersion, string? PackageId, string? RegistryHive,
    string? RegistryView, string? RegistryKey, string? InstallLocation,
    string? DisplayIcon, string? Architecture, string? InstallScope,
    bool? WindowsInstaller, string? PackageFamilyName = null);
internal sealed record RegistryObservation(
    string Hive, string View, string Key, string DisplayName, string? Publisher,
    string? InstalledVersion, string? InstallLocation, string? DisplayIcon,
    string? UninstallString, bool WindowsInstaller);
internal sealed record ScanResult(string Status, IReadOnlyList<ScanApplication> Applications,
    int RawObservationCount, string? ErrorCode);
internal sealed record WinGetPackage(string PackageIdentifier, string? Version);
internal sealed record UpdateClaim(
    string Id, string DeviceId, string ApplicationId, string Status, string PackageId,
    string Source, string? InstalledVersion, string TargetVersion, string? Publisher,
    string StableKey, string? EvidenceHash, DateTimeOffset? LeaseUntil);
internal sealed record UpdateResult(
    string Status, string? ObservedVersion, int? ExitCode, string? DiagnosticCode,
    bool ExecutionStarted);
internal sealed record UpdateProgress(string Stage, int? Percent, long? DownloadedBytes, long? TotalBytes);
