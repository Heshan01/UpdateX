using UpdatePilot.Agent;

if (!OperatingSystem.IsWindows())
{
    Console.Error.WriteLine("UpdateX Agent requires Windows.");
    return 2;
}

string apiBase = (Environment.GetEnvironmentVariable("UPDATEX_API_BASE") ?? "https://updatepilotapi-production.up.railway.app").TrimEnd('/');

using var shutdown = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) => { eventArgs.Cancel = true; shutdown.Cancel(); };

try
{
    // Check before opening an agent identity, pairing, scanning or polling jobs.
    using var readiness = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
    try
    {
        using var response = await readiness.GetAsync($"{apiBase}/api/v1/ready", shutdown.Token);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"Cloud API responded with status code {response.StatusCode}.");
        using var document = System.Text.Json.JsonDocument.Parse(await response.Content.ReadAsStreamAsync(shutdown.Token));
        if (!document.RootElement.TryGetProperty("status", out var statusProp) || statusProp.GetString() != "ready")
            throw new InvalidOperationException("UpdateX Cloud API is not ready.");
    }
    catch (Exception error) when (error is not OperationCanceledException)
    {
        Console.Error.WriteLine($"Agent unavailable until UpdateX API is reachable: {error.Message}");
        return 4;
    }

    if (args.Contains("--scan-local", StringComparer.Ordinal))
    {
        var (applications, catalogError, rawCount) = await InventoryScanner.ScanAsync(shutdown.Token);
        Console.WriteLine($"Read-only scan: {rawCount} raw observations → {applications.Count} logical applications; " +
            $"{applications.Count(item => item.PackageId is not null)} WinGet identities; " +
            $"{applications.Count(item => item.UpdateStatus == "available")} verified updates.");
        if (args.Contains("--details", StringComparer.Ordinal))
        {
            foreach (ScanApplication item in applications.Where(item => item.UpdateStatus == "available" ||
                System.Text.RegularExpressions.Regex.IsMatch(item.DisplayName,
                    "Antigravity|Claude|ClickUp|HandBrake|Chipset Device|Rapid Storage|Development Kit",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase)))
                Console.WriteLine($"{item.DisplayName} | {item.Publisher ?? "Unknown"} | " +
                    $"{item.InstalledVersion ?? "Unknown"} | {item.PackageId ?? "Unmatched"} | " +
                    $"{item.MatchStatus}/{item.UpdateStatus} | {item.Observations.Count} sources | " +
                    $"{item.InstallScope ?? "unknown"}/{item.Architecture ?? "unknown"}.");
        }
        if (catalogError is not null) Console.WriteLine($"WinGet catalog: {catalogError}.");
        return 0;
    }

    using var instance = new Mutex(true, $"Local\\UpdateX.Agent.{Environment.UserName}", out bool firstInstance);
    if (!firstInstance)
    {
        Console.Error.WriteLine("Another UpdateX agent is already running for this Windows user. Stop it before starting a replacement.");
        return 3;
    }

    bool rotatingKey = args.Contains("--rotate-key", StringComparer.Ordinal) ||
        args.Contains("--recover-key", StringComparer.Ordinal);
    using var identity = rotatingKey ? AgentIdentity.OpenPending() : AgentIdentity.Open();
    using var api = new AgentClient(identity);
    if (identity.DeviceId is null)
    {
        if (identity.PairingId is not null)
        {
            try
            {
                PairingStatusResponse prior = await api.PollPairingAsync(identity.PairingId, shutdown.Token);
                if (prior.Paired && prior.DeviceId is not null) identity.SaveDevice(prior.DeviceId);
            }
            catch (AgentApiException error) when (error.Code == "PAIRING_EXPIRED") { }
        }
    }
    if (identity.DeviceId is null)
    {
        PairingStartResponse pairing = await api.StartPairingAsync(shutdown.Token);
        identity.SavePairingId(pairing.PairingId);
        Console.WriteLine(rotatingKey
            ? "Stop the previous agent, then approve this new key for the existing offline device in UpdateX Settings:"
            : "Pair this Windows agent in UpdateX Settings:");
        Console.WriteLine($"Code: {pairing.Code}");
        Console.WriteLine($"Key fingerprint: {pairing.Fingerprint}");
        Console.WriteLine("The code expires in ten minutes. Keep this window open while approving it.");
        while (!shutdown.IsCancellationRequested && DateTimeOffset.UtcNow < pairing.ExpiresAt)
        {
            await Task.Delay(TimeSpan.FromSeconds(3), shutdown.Token);
            PairingStatusResponse status = await api.PollPairingAsync(pairing.PairingId, shutdown.Token);
            if (status.Paired && status.DeviceId is not null)
            {
                identity.SaveDevice(status.DeviceId);
                Console.WriteLine("Agent paired. The first scan is queued.");
                break;
            }
        }
        if (identity.DeviceId is null) throw new InvalidOperationException("Pairing expired without owner approval.");
    }

    bool once = args.Contains("--once", StringComparer.Ordinal);
    // A normal licensed, paired agent is ready to run only jobs that the local
    // user explicitly previewed and confirmed. Key recovery cannot run jobs.
    bool allowUpdates = !rotatingKey;
    Console.WriteLine(allowUpdates
        ? "Agent connected. Confirmed update jobs may execute under this Windows user."
        : "Agent key recovery session. Update jobs are unavailable until recovery is approved.");
    bool updateNoticeShown = false;
    int connectionFailures = 0;
    while (!shutdown.IsCancellationRequested)
    {
      try
      {
        await api.HeartbeatAsync(allowUpdates, shutdown.Token);
        NextJobResponse job = await api.NextJobAsync(shutdown.Token);
        connectionFailures = 0;
        if (job.Kind == "scan" && job.JobId is not null)
        {
            await api.ClaimScanAsync(job.JobId, shutdown.Token);
            await using var lease = new LeaseKeeper(TimeSpan.FromMinutes(1), renewToken => api.RenewScanAsync(job.JobId, renewToken));
            try
            {
                var (applications, catalogError, rawCount) = await InventoryScanner.ScanAsync(shutdown.Token);
                await api.SubmitScanAsync(job.JobId, new ScanResult("succeeded", applications, rawCount, null), shutdown.Token);
                Console.WriteLine($"Scan saved: {rawCount} raw observations → {applications.Count} logical applications; " +
                    $"{applications.Count(item => item.PackageId is not null)} WinGet identities.");
                if (catalogError is not null) Console.WriteLine($"WinGet catalog: {catalogError}.");
            }
            catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { throw; }
            catch (Exception error)
            {
                try { await api.SubmitScanAsync(job.JobId, new ScanResult("failed", [], 0, "SCAN_FAILED"), shutdown.Token); }
                catch { /* The server lease will eventually classify an unreported scan. */ }
                AgentLog.Write("scan_failed", AgentLog.Classify(error));
            }
            if (once) break;
        }
        else if (job.Kind == "update")
        {
            if (allowUpdates && job.JobId is not null)
            {
                await UpdateRunner.RunAsync(api, job.JobId, shutdown.Token);
                updateNoticeShown = false;
            }
            else if (!updateNoticeShown)
            {
                Console.WriteLine("An update is queued, but this agent run cannot execute software changes.");
                updateNoticeShown = true;
            }
            if (once) break;
        }
        else if (once) break;
        await Task.Delay(TimeSpan.FromSeconds(5), shutdown.Token);
      }
      catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { break; }
      catch (AgentApiException error) when (error.Code is "AGENT_REVOKED" or "AGENT_ID_INVALID")
      {
          AgentLog.Write("identity_rejected", error.Code);
          return 1;
      }
      catch (Exception error)
      {
          connectionFailures = Math.Min(connectionFailures + 1, 6);
          var delay = TimeSpan.FromSeconds(Math.Min(30, 1 << (connectionFailures - 1)));
          AgentLog.Write("connection_retry", AgentLog.Classify(error));
          if (once) return 1;
          await Task.Delay(delay, shutdown.Token);
      }
    }
    return 0;
}
catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { return 0; }
catch (Exception error)
{
    AgentLog.Write("agent_stopped", AgentLog.Classify(error));
    return 1;
}
