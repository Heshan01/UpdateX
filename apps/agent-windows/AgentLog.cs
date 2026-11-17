using System.Text.Json;

namespace UpdatePilot.Agent;

internal static class AgentLog
{
    public static void Write(string eventName, string code) => Console.Error.WriteLine(JsonSerializer.Serialize(new
    {
        timestamp = DateTimeOffset.UtcNow,
        component = "updatex-agent",
        @event = eventName,
        code,
    }));

    public static string Classify(Exception error) => error switch
    {
        AgentApiException api => api.Code,
        HttpRequestException => "API_UNAVAILABLE",
        TaskCanceledException => "API_TIMEOUT",
        _ => "AGENT_OPERATION_FAILED",
    };
}

internal sealed class AgentApiException(int status, string code) : Exception("Local API request failed")
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}
