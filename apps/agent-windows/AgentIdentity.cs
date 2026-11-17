using System.Security.Cryptography;
using System.Text.Json;

namespace UpdatePilot.Agent;

internal sealed class AgentIdentity : IDisposable
{
    private readonly string configPath;
    private AgentConfiguration config;
    private readonly ECDsaCng key;

    private AgentIdentity(string path, AgentConfiguration saved, ECDsaCng signer)
    {
        configPath = path;
        config = saved;
        key = signer;
    }

    public string? DeviceId => config.DeviceId;
    public string? PairingId => config.PairingId;
    public string PublicKeyPem => key.ExportSubjectPublicKeyInfoPem();

    public static AgentIdentity Open()
    {
        string folder = IdentityFolder();
        string path = Path.Combine(folder, "agent.json");
        AgentConfiguration saved;
        if (File.Exists(path))
        {
            saved = JsonSerializer.Deserialize<AgentConfiguration>(File.ReadAllText(path))
                ?? throw new InvalidOperationException("Agent identity file is invalid.");
        }
        else
        {
            saved = new AgentConfiguration($"UpdatePilot.Agent.{Guid.NewGuid():N}", null);
            using var created = CngKey.Create(CngAlgorithm.ECDsaP256, saved.KeyName, new CngKeyCreationParameters
            {
                Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider,
                KeyCreationOptions = CngKeyCreationOptions.None,
                ExportPolicy = CngExportPolicies.None,
                KeyUsage = CngKeyUsages.Signing,
            });
            File.WriteAllText(path, JsonSerializer.Serialize(saved));
        }
        if (!CngKey.Exists(saved.KeyName, CngProvider.MicrosoftSoftwareKeyStorageProvider))
            throw new InvalidOperationException("The Windows user key is missing. Re-pairing requires a new identity.");
        var cng = CngKey.Open(saved.KeyName, CngProvider.MicrosoftSoftwareKeyStorageProvider);
        return new AgentIdentity(path, saved, new ECDsaCng(cng));
    }

    public static AgentIdentity OpenPending()
    {
        string folder = IdentityFolder();
        string path = Path.Combine(folder, "agent.pending.json");
        AgentConfiguration saved;
        if (File.Exists(path))
        {
            saved = JsonSerializer.Deserialize<AgentConfiguration>(File.ReadAllText(path))
                ?? throw new InvalidOperationException("Pending agent identity file is invalid.");
        }
        else
        {
            saved = new AgentConfiguration($"UpdatePilot.Agent.{Guid.NewGuid():N}", null);
            using var created = CngKey.Create(CngAlgorithm.ECDsaP256, saved.KeyName, new CngKeyCreationParameters
            {
                Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider,
                KeyCreationOptions = CngKeyCreationOptions.None,
                ExportPolicy = CngExportPolicies.None,
                KeyUsage = CngKeyUsages.Signing,
            });
            File.WriteAllText(path, JsonSerializer.Serialize(saved));
        }
        if (!CngKey.Exists(saved.KeyName, CngProvider.MicrosoftSoftwareKeyStorageProvider))
            throw new InvalidOperationException("Pending Windows user key is missing.");
        if (saved.DeviceId is not null)
        {
            string currentPath = Path.Combine(folder, "agent.json");
            File.Move(path, currentPath, true);
            path = currentPath;
        }
        var cng = CngKey.Open(saved.KeyName, CngProvider.MicrosoftSoftwareKeyStorageProvider);
        return new AgentIdentity(path, saved, new ECDsaCng(cng));
    }

    public string Sign(string message)
    {
        byte[] signature = key.SignData(System.Text.Encoding.UTF8.GetBytes(message), HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return Base64Url(signature);
    }

    public static string Base64Url(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public void SaveDevice(string deviceId)
    {
        config = config with { DeviceId = deviceId, PairingId = null };
        File.WriteAllText(configPath, JsonSerializer.Serialize(config));
        if (Path.GetFileName(configPath).Equals("agent.pending.json", StringComparison.OrdinalIgnoreCase))
            File.Move(configPath, Path.Combine(Path.GetDirectoryName(configPath)!, "agent.json"), true);
    }

    public void SavePairingId(string pairingId)
    {
        config = config with { PairingId = pairingId };
        File.WriteAllText(configPath, JsonSerializer.Serialize(config));
    }

    public void Dispose() => key.Dispose();

    private static string IdentityFolder()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string folder = Path.Combine(local, "UpdateX");
        string legacy = Path.Combine(local, "UpdatePilot");
        Directory.CreateDirectory(folder);
        // Preserve the Windows CNG key name and device ID from earlier builds.
        // Copy only when the new path is absent; never delete the old identity.
        foreach (string name in new[] { "agent.json", "agent.pending.json" })
        {
            string oldPath = Path.Combine(legacy, name);
            string newPath = Path.Combine(folder, name);
            if (!File.Exists(newPath) && File.Exists(oldPath)) File.Copy(oldPath, newPath);
        }
        return folder;
    }
}
