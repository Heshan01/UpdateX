using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace UpdatePilot.Agent;

internal sealed class AgentClient : IDisposable
{
    private readonly AgentIdentity identity;
    private readonly HttpClient client = new() { BaseAddress = new Uri("http://127.0.0.1:4000/api/v1/agent/"), Timeout = TimeSpan.FromSeconds(40) };
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public AgentClient(AgentIdentity identity) => this.identity = identity;

    public async Task<PairingStartResponse> StartPairingAsync(CancellationToken token)
    {
        var input = new { deviceName = Environment.MachineName, agentVersion = "0.2.0",
            osVersion = Environment.OSVersion.VersionString, publicKeyPem = identity.PublicKeyPem };
        using var response = await client.PostAsJsonAsync("pairing/start", input, JsonOptions, token);
        return await ReadAsync<PairingStartResponse>(response, token);
    }

    public async Task<PairingStatusResponse> PollPairingAsync(string pairingId, CancellationToken token)
    {
        string timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        string nonce = AgentIdentity.Base64Url(RandomNumberGenerator.GetBytes(24));
        string signature = identity.Sign(string.Join('\n', "PAIR", pairingId, timestamp, nonce));
        using var request = new HttpRequestMessage(HttpMethod.Get, $"pairing/{pairingId}");
        request.Headers.Add("X-UP-Timestamp", timestamp);
        request.Headers.Add("X-UP-Nonce", nonce);
        request.Headers.Add("X-UP-Signature", signature);
        using var response = await client.SendAsync(request, token);
        return await ReadAsync<PairingStatusResponse>(response, token);
    }

    public Task<NextJobResponse> NextJobAsync(CancellationToken token) => SendSignedAsync<NextJobResponse>(HttpMethod.Get, "jobs/next", null, token);
    public Task HeartbeatAsync(bool allowUpdates, CancellationToken token) => SendSignedAsync<object>(HttpMethod.Post,
        "heartbeat", new { executionMode = allowUpdates ? "update_enabled" : "read_only" }, token);
    public Task ClaimScanAsync(string jobId, CancellationToken token) => SendSignedAsync<object>(HttpMethod.Post, $"scans/{jobId}/claim", new { }, token);
    public Task RenewScanAsync(string jobId, CancellationToken token) => SendSignedAsync<object>(HttpMethod.Post, $"scans/{jobId}/renew", new { }, token);
    public Task SubmitScanAsync(string jobId, ScanResult result, CancellationToken token) => SendSignedAsync<object>(HttpMethod.Post, $"scans/{jobId}/result", result, token);
    public Task<UpdateClaim> ClaimUpdateAsync(string jobId, CancellationToken token) =>
        SendSignedAsync<UpdateClaim>(HttpMethod.Post, $"updates/{jobId}/claim", new { }, token);
    public Task MarkUpdateStartedAsync(string jobId, CancellationToken token) =>
        SendSignedAsync<object>(HttpMethod.Post, $"updates/{jobId}/started", new { }, token);
    public Task MarkUpdateVerifyingAsync(string jobId, CancellationToken token) =>
        SendSignedAsync<object>(HttpMethod.Post, $"updates/{jobId}/verifying", new { }, token);
    public Task RenewUpdateAsync(string jobId, CancellationToken token) =>
        SendSignedAsync<object>(HttpMethod.Post, $"updates/{jobId}/renew", new { }, token);
    public Task SubmitUpdateResultAsync(string jobId, UpdateResult result, CancellationToken token) =>
        SendSignedAsync<object>(HttpMethod.Post, $"updates/{jobId}/result", result, token);
    public Task ReportUpdateProgressAsync(string jobId, UpdateProgress progress, CancellationToken token) =>
        SendSignedAsync<object>(HttpMethod.Post, $"updates/{jobId}/progress", progress, token);

    private async Task<T> SendSignedAsync<T>(HttpMethod method, string path, object? body, CancellationToken token)
    {
        string deviceId = identity.DeviceId ?? throw new InvalidOperationException("Agent is not paired.");
        byte[] bytes = body is null ? [] : JsonSerializer.SerializeToUtf8Bytes(body, JsonOptions);
        string bodyHash = Convert.ToHexStringLower(SHA256.HashData(bytes));
        string timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        string nonce = AgentIdentity.Base64Url(RandomNumberGenerator.GetBytes(24));
        string signedPath = $"/api/v1/agent/{path}";
        string message = string.Join('\n', method.Method.ToUpperInvariant(), signedPath, bodyHash, deviceId, timestamp, nonce);
        using var request = new HttpRequestMessage(method, path);
        if (body is not null) request.Content = new ByteArrayContent(bytes) { Headers = { ContentType = new("application/json") } };
        request.Headers.Add("X-UP-Device-Id", deviceId);
        request.Headers.Add("X-UP-Timestamp", timestamp);
        request.Headers.Add("X-UP-Nonce", nonce);
        request.Headers.Add("X-UP-Signature", identity.Sign(message));
        using var response = await client.SendAsync(request, token);
        return await ReadAsync<T>(response, token);
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken token)
    {
        if (!response.IsSuccessStatusCode)
        {
            string code = "API_ERROR";
            try
            {
                using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
                code = document.RootElement.GetProperty("code").GetString() ?? code;
            }
            catch { /* A malformed response must not expose its body in logs. */ }
            throw new AgentApiException((int)response.StatusCode, code);
        }
        return await response.Content.ReadFromJsonAsync<T>(JsonOptions, token)
            ?? throw new InvalidOperationException("Local API returned an empty response.");
    }

    public void Dispose() => client.Dispose();
}
