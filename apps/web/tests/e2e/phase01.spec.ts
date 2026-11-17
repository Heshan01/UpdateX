import { expect, test, type Page } from "@playwright/test";
import type {
  ApplicationDto, AuthState, DashboardDto, DeviceDto, HistoryItemDto, Page as ApiPage,
  ScanJobDto, UpdatePreviewDto,
  UpdateJobDto,
} from "@updatepilot/contracts";

const username = "test-owner";
const password = "Test-Only-Passphrase-1234";
const csrfToken = "isolated-test-csrf";
const deviceId = "c123456789012345678901234";
const scanId = "fixture-scan-1";

type Options = { authenticated?: boolean; connection?: "online" | "offline"; saved?: boolean;
  simulatedUpdate?: "succeeded" | "failed" };

async function mockLocalApi(page: Page, options: Options = {}) {
  let authenticated = options.authenticated ?? true;
  let accessMode: "guest" | "account" = "account";
  let saved = options.saved ?? true;
  let scanStarted = false;
  let scanReads = 0;
  let jobReads = 0;
  let updateQueued = false;
  let scanReminderDays = 7;
  let jobStatus: UpdateJobDto["status"] = "queued";
  const connection = options.connection ?? "online";
  const scannedAt = new Date(Date.now() - 60_000).toISOString();
  const calls = { login: 0, guest: 0, register: 0, scans: 0, previews: [] as string[], executions: 0, settingsPatches: [] as number[],
    confirmations: [] as unknown[], latest: 0, unhandled: [] as string[] };

  const auth = (): AuthState => authenticated
    ? { initialized: true, accountAvailable: true, authenticated: true, mode: accessMode,
      username: accessMode === "guest" ? "Guest" : username, csrfToken }
    : { initialized: true, accountAvailable: true, authenticated: false };
  const device = (): DeviceDto => ({
    id: deviceId, name: "TEST-WINDOWS-PC", agentVersion: "test-only", osVersion: "Windows test fixture",
    lastSeenAt: scannedAt, lastHeartbeatAt: connection === "online" ? new Date().toISOString() : scannedAt,
    executionMode: options.simulatedUpdate ? "update_enabled" : "read_only", revokedAt: null, connection,
  });
  const dashboard = (): DashboardDto => ({
    inventoryCount: saved ? 1 : 0, updateCount: saved ? 1 : 0, unsupportedCount: 0,
    lastScanAt: saved ? scannedAt : null, agent: device(), recentActivity: [], scanReminderDays,
  });
  const application = (): ApplicationDto => ({
    id: "git-app", deviceId, displayName: "Git", publisher: "The Git Development Community",
    installedVersion: "2.54.0", packageId: "Git.Git", source: "winget", availableVersion: "2.55.0.5",
    matchStatus: "verified", updateStatus: "available", matchReason: "Exact test fixture identity",
    observedAt: scannedAt, installScope: "machine", architecture: "x64", installationType: "desktop",
    observationCount: 2,
  });
  const pageOf = <T,>(items: T[]): ApiPage<T> => ({ items, page: 1, pageSize: 20,
    total: items.length, totalPages: Math.max(1, Math.ceil(items.length / 20)) });
  const scan = (status: ScanJobDto["status"]): ScanJobDto => ({
    id: scanId, deviceId, status, createdAt: scannedAt,
    startedAt: status === "queued" ? null : scannedAt,
    completedAt: status === "succeeded" ? new Date().toISOString() : null, errorCode: null,
  });
  const job = (status: UpdateJobDto["status"]): UpdateJobDto => ({
    id: "fixture-job", deviceId, applicationId: "git-app", status, packageId: "Git.Git",
    source: "winget", installedVersion: "2.54.0", targetVersion: "2.55.0.5",
    observedVersion: status === "succeeded" ? "2.55.0.5" : null,
    exitCode: status === "failed" ? 1 : status === "succeeded" ? 0 : null,
    diagnosticCode: status === "failed" ? "WINGET_EXIT_NONZERO" : null,
    createdAt: scannedAt, startedAt: status === "queued" ? null : scannedAt,
    completedAt: ["succeeded", "failed"].includes(status) ? new Date().toISOString() : null,
  });

  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/v1/, "");
    const method = request.method();
    const reply = (value: unknown, status = 200) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(value),
    });

    if (method === "GET" && path === "/auth/state") return reply(auth());
    if (method === "POST" && path === "/auth/session") {
      calls.login += 1;
      const submitted = request.postDataJSON() as { username?: string; password?: string };
      if (submitted.username !== username || submitted.password !== password) {
        return reply({ code: "INVALID_CREDENTIALS", message: "Invalid credentials.", requestId: "fixture" }, 401);
      }
      authenticated = true;
      accessMode = "account";
      return reply(auth(), 201);
    }
    if (method === "POST" && path === "/auth/guest") {
      calls.guest += 1;
      authenticated = true;
      accessMode = "guest";
      return reply(auth());
    }
    if (method === "POST" && path === "/auth/register") {
      calls.register += 1;
      authenticated = true;
      accessMode = "account";
      return reply(auth(), 201);
    }
    if (method === "DELETE" && path === "/auth/session") {
      authenticated = false;
      return route.fulfill({ status: 204, body: "" });
    }
    if (!authenticated) return reply({ code: "AUTH_REQUIRED", message: "Sign in first.", requestId: "fixture" }, 401);
    if (method === "GET" && path === "/settings") return reply({ theme: "dark", retentionDays: 90, scanReminderDays });
    if (method === "PATCH" && path === "/settings") {
      if (request.headers()["x-csrf-token"] !== csrfToken) return reply({ code: "CSRF_REQUIRED" }, 403);
      const body = request.postDataJSON() as { scanReminderDays?: number };
      if (body.scanReminderDays) { scanReminderDays = body.scanReminderDays; calls.settingsPatches.push(scanReminderDays); }
      return reply({ theme: "dark", retentionDays: 90, scanReminderDays });
    }
    if (method === "GET" && path === "/dashboard") return reply(dashboard());
    if (method === "GET" && path === "/devices") return reply({ items: [device()] });
    if (method === "GET" && path === `/devices/${deviceId}/scans/latest`) {
      calls.latest += 1;
      return reply(scanStarted ? scan("succeeded") : null);
    }
    if (method === "POST" && path === `/devices/${deviceId}/scans`) {
      if (request.headers()["x-csrf-token"] !== csrfToken) {
        return reply({ code: "CSRF_REQUIRED", message: "CSRF token required.", requestId: "fixture" }, 403);
      }
      calls.scans += 1;
      scanStarted = true;
      scanReads = 0;
      return reply(scan("queued"), 202);
    }
    if (method === "GET" && path === `/scans/${scanId}`) {
      scanReads += 1;
      if (scanReads >= 3) saved = true;
      return reply(scan(scanReads === 1 ? "queued" : scanReads === 2 ? "running" : "succeeded"));
    }
    if (method === "GET" && path === "/applications") return reply(pageOf(saved ? [application()] : []));
    if (method === "GET" && path === "/applications/export.csv") return route.fulfill({ status: 200, contentType: "text/csv", body: '"Application","Installed version"\r\n"Git","2.54.0"\r\n' });
    if (method === "GET" && path === "/applications/git-app") return reply(application());
    if (method === "GET" && path === "/applications/git-app/release-info") return reply({ status: "unavailable", version: "2.55.0.5", releaseDate: null, notes: null, officialUrl: null, source: null });
    if (method === "POST" && path === "/applications/git-app/preview") {
      calls.previews.push("git-app");
      const preview: UpdatePreviewDto = {
        id: "fixture-preview", applicationId: "git-app", deviceId, packageId: "Git.Git", source: "winget",
        publisher: "The Git Development Community", installedVersion: "2.54.0", targetVersion: "2.55.0.5",
        expiresAt: new Date(Date.now() + 300_000).toISOString(), warnings: ["Test preview only. No installer runs."],
      };
      return reply(preview, 201);
    }
    if (method === "GET" && path === "/updates") return reply(pageOf(saved ? [application()] : []));
    if (method === "GET" && path === "/jobs") return reply({ items: updateQueued ? [job(jobStatus)] : [] });
    if (method === "GET" && path === "/jobs/fixture-job" && updateQueued) {
      jobReads += 1;
      jobStatus = jobReads === 1 ? "running" : jobReads === 2 ? "verifying" : options.simulatedUpdate ?? "failed";
      return reply({ ...job(jobStatus), events: [{ id: "fixture-event", status: jobStatus,
        detail: jobStatus === "succeeded" ? "Verified 2.55.0.5" : jobStatus === "failed" ? "WINGET_EXIT_NONZERO" : "Agent progress",
        createdAt: new Date().toISOString() }] });
    }
    if (method === "GET" && path === "/history") {
      const items: HistoryItemDto[] = saved ? [{ id: "fixture-history", kind: "scan", title: "scan succeeded",
        detail: "Isolated test scan result", status: "succeeded", createdAt: scannedAt }] : [];
      if (["succeeded", "failed"].includes(jobStatus) && updateQueued) items.unshift({
        id: "fixture-update-history", kind: "update", title: `update ${jobStatus}`,
        detail: jobStatus === "succeeded" ? "Git.Git verified at 2.55.0.5" : "Git.Git: WINGET_EXIT_NONZERO",
        status: jobStatus, createdAt: new Date().toISOString(),
      });
      return reply(pageOf(items));
    }
    if (method === "GET" && path === "/update-history") return reply(pageOf(updateQueued ? [{ ...job(jobStatus), applicationName: "Git", publisher: "The Git Development Community", events: [] }] : []));
    if (method === "GET" && path === "/update-history/export.csv") return route.fulfill({ status: 200, contentType: "text/csv", body: '"Application","Update status"\r\n"Git","succeeded"\r\n' });
    if (method === "POST" && path === "/updates/execute") {
      calls.executions += 1;
      calls.confirmations.push(request.postDataJSON());
      if (!options.simulatedUpdate) return reply({ code: "TEST_BLOCKED", message: "Updates are forbidden in browser tests.", requestId: "fixture" }, 403);
      const input = request.postDataJSON() as { previewId?: string; confirmation?: boolean; idempotencyKey?: string };
      if (request.headers()["x-csrf-token"] !== csrfToken || input.previewId !== "fixture-preview" ||
          input.confirmation !== true || !input.idempotencyKey) return reply({ code: "INVALID_TEST_CONFIRMATION" }, 403);
      updateQueued = true;
      return reply(job("queued"), 202);
    }
    calls.unhandled.push(`${method} ${path}`);
    return reply({ code: "UNMOCKED_TEST_ROUTE", message: "No isolated test response exists.", requestId: "fixture" }, 501);
  });

  return calls;
}

test("login opens Scan and saved navigation survives reload", async ({ page }) => {
  const calls = await mockLocalApi(page, { authenticated: false, saved: true });
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect.poll(() => calls.login).toBe(1);
  await expect(page).toHaveURL(/\/overview$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "1 software updates available" })).toBeVisible();
  await page.getByRole("link", { name: "Applications", exact: true }).click();
  await expect(page.getByRole("link", { name: "Git", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: "Git", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page.getByText("Isolated test scan result")).toBeVisible();
  expect(calls.login).toBe(1);
  expect(calls.scans).toBe(0);
  expect(calls.unhandled).toEqual([]);
});

test("invalid login stays on the sign-in screen", async ({ page }) => {
  const calls = await mockLocalApi(page, { authenticated: false });
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill("Wrong-Test-Passphrase-1234");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByText("Invalid credentials.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(calls.login).toBe(1);
  expect(calls.unhandled).toEqual([]);
});

test("Welcome offers three access methods and Guest opens Scan directly", async ({ page }) => {
  const calls = await mockLocalApi(page, { authenticated: false });
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Sign In" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign Up" })).toBeVisible();
  await page.getByRole("button", { name: "Continue as Guest" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByText("Guest", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByText("Guest", { exact: true }).first()).toBeVisible();
  expect(calls.guest).toBe(1);
  expect(calls.login).toBe(0);
  expect(calls.register).toBe(0);
  expect(calls.unhandled).toEqual([]);
});

test("account sign-out returns to Welcome without creating a Guest session", async ({ page }) => {
  const calls = await mockLocalApi(page);
  await page.goto("/overview");
  await page.getByRole("button", { name: "Local account" }).click();
  await page.getByRole("button", { name: "Sign Out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Welcome to UpdateX" })).toBeVisible();
  expect(calls.guest).toBe(0);
  expect(calls.unhandled).toEqual([]);
});

test("Sign Up validates confirmation before creating a local account", async ({ page }) => {
  const calls = await mockLocalApi(page, { authenticated: false });
  await page.goto("/sign-up");
  await page.getByLabel("Username").fill("new-owner");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password").fill("Different-Passphrase-1234");
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();
  expect(calls.register).toBe(0);
  await page.getByLabel("Confirm Password").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  expect(calls.register).toBe(1);
  expect(calls.unhandled).toEqual([]);
});

test("offline agent keeps saved inventory and update review available", async ({ page }) => {
  const calls = await mockLocalApi(page, { connection: "offline", saved: true });
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "1 software updates available" })).toBeVisible();
  await expect(page.getByText(/Agent offline/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan again" })).toBeDisabled();
  await page.getByRole("link", { name: "Applications", exact: true }).click();
  await expect(page.getByRole("link", { name: "Git", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Updates/ }).first().click();
  await expect(page.getByText(/Agent offline\. Saved update opportunities/)).toBeVisible();
  expect(calls.scans).toBe(0);
  expect(calls.executions).toBe(0);
  expect(calls.unhandled).toEqual([]);
});

test("offline agent with no saved scan cannot start one", async ({ page }) => {
  const calls = await mockLocalApi(page, { connection: "offline", saved: false });
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "Agent is offline" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Windows agent offline" })).toBeDisabled();
  expect(calls.scans).toBe(0);
  expect(calls.unhandled).toEqual([]);
});

test("central Scan sends an authenticated request and follows real job states", async ({ page }) => {
  const calls = await mockLocalApi(page, { saved: false, connection: "online" });
  await page.goto("/overview");
  await expect.poll(() => calls.latest).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Start read-only software scan" }).click();
  await expect(page.getByText("Scan queued · waiting for agent")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scanning your software" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "1 software updates available" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Scan again" })).toBeEnabled();
  expect(calls.scans).toBe(1);
  expect(calls.executions).toBe(0);
  expect(calls.unhandled).toEqual([]);
});

test("Applications Review opens the exact package preview without queueing", async ({ page }) => {
  const calls = await mockLocalApi(page, { saved: true, connection: "online" });
  await page.goto("/applications");
  await page.getByRole("link", { name: "Review update for Git" }).click();
  const dialog = page.getByRole("dialog", { name: "Git" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Git.Git");
  await expect(dialog).toContainText("2.55.0.5");
  await expect(dialog.getByRole("button", { name: "Confirm and queue" })).toBeDisabled();
  expect(calls.previews).toEqual(["git-app"]);
  expect(calls.executions).toBe(0);
  expect(calls.unhandled).toEqual([]);
});

test("inventory and update-history CSV buttons download saved data", async ({ page }) => {
  const calls = await mockLocalApi(page, { saved: true });
  await page.goto("/applications");
  const inventoryDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await inventoryDownload).suggestedFilename()).toBe("updatex-applications.csv");
  await page.getByRole("link", { name: "History", exact: true }).click();
  const historyDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export update history" }).click();
  expect((await historyDownload).suggestedFilename()).toBe("updatex-update-history.csv");
  expect(calls.unhandled).toEqual([]);
});

test("scan-age preference saves and reloads through the local API", async ({ page }) => {
  const calls = await mockLocalApi(page);
  await page.goto("/settings");
  await page.getByLabel("Mark saved results as old after").selectOption("30");
  await expect.poll(() => calls.settingsPatches).toEqual([30]);
  await page.reload();
  await expect(page.getByLabel("Mark saved results as old after")).toHaveValue("30");
  expect(calls.unhandled).toEqual([]);
});

for (const terminal of ["succeeded", "failed"] as const) {
  test(`exact preview, explicit confirmation and ${terminal} job history use isolated responses`, async ({ page }) => {
    const calls = await mockLocalApi(page, { saved: true, simulatedUpdate: terminal });
    await page.goto("/applications");
    await page.getByRole("link", { name: "Review update for Git" }).click();
    const dialog = page.getByRole("dialog", { name: "Git" });
    await expect(dialog).toContainText("Git.Git");
    await expect(dialog).toContainText("2.54.0");
    await expect(dialog).toContainText("2.55.0.5");
    const confirm = dialog.getByRole("button", { name: "Confirm and queue" });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByText("Update job: queued")).toBeVisible();
    await expect(page.getByText(`Update job: ${terminal}`)).toBeVisible({ timeout: 20_000 });
    if (terminal === "succeeded") await expect(page.getByText(/observed 2\.55\.0\.5/).first()).toBeVisible();
    else await expect(page.getByText(/WINGET_EXIT_NONZERO/).first()).toBeVisible();
    await page.getByRole("button", { name: "View job details for Git.Git" }).click();
    await expect(page.getByRole("list", { name: "Job events" })).toContainText(
      terminal === "succeeded" ? "Verified 2.55.0.5" : "WINGET_EXIT_NONZERO");
    await page.getByRole("link", { name: "History", exact: true }).click();
    await expect(page.getByText(terminal === "succeeded" ? "Succeeded" : "Failed", { exact: true }).first()).toBeVisible();
    expect(calls.previews).toEqual(["git-app"]);
    expect(calls.executions).toBe(1);
    expect(calls.confirmations).toEqual([expect.objectContaining({
      previewId: "fixture-preview", confirmation: true, idempotencyKey: expect.any(String),
    })]);
    expect(calls.unhandled).toEqual([]);
  });
}
