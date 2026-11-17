namespace UpdatePilot.Agent;

// A temporary API outage never causes a second execution. The server owns the lease and
// eventually classifies an unreported update as uncertain rather than queuing it again.
internal sealed class LeaseKeeper : IAsyncDisposable
{
    private readonly CancellationTokenSource stop = new();
    private readonly Task loop;

    public LeaseKeeper(TimeSpan interval, Func<CancellationToken, Task> renew)
    {
        loop = Task.Run(async () =>
        {
            using var timer = new PeriodicTimer(interval);
            try
            {
                while (await timer.WaitForNextTickAsync(stop.Token))
                {
                    try { await renew(stop.Token); }
                    catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
                    catch { AgentLog.Write("lease_renewal_failed", "API_UNAVAILABLE"); }
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        });
    }

    public async ValueTask DisposeAsync()
    {
        await stop.CancelAsync();
        await loop;
        stop.Dispose();
    }
}
