import type { ApiError } from "@updatepilot/contracts";

export class RequestError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}, csrfToken?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    let payload: ApiError | null = null;
    try { payload = await response.json() as ApiError; } catch { /* A proxy failure may not return JSON. */ }
    throw new RequestError(response.status, payload?.code ?? "REQUEST_FAILED", payload?.message ?? "The local service could not complete the request.");
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown, csrfToken?: string) => request<T>(path, { method: "POST", body: JSON.stringify(body) }, csrfToken),
  patch: <T>(path: string, body: unknown, csrfToken: string) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }, csrfToken),
  delete: <T>(path: string, csrfToken: string) => request<T>(path, { method: "DELETE" }, csrfToken),
};
