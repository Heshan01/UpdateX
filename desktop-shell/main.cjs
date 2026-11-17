const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell, Tray } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { fileURLToPath } = require("node:url");
const license = require("./license-format.cjs");
const { createStartupGate, missingRuntimeAssets, stopStartedServices } = require("./startup-policy.cjs");

const origin = "http://127.0.0.1:3000";
const apiOrigin = "http://127.0.0.1:4000/api/v1";
const sqliteDatabasePath = () => path.join(process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local"),
  "UpdateX", "data", "updatex.db");
const sqliteFileUrl = file => "file:" + path.resolve(file).replaceAll("\\", "/");
let mainWindow;
let tray;
const children = [];
let internalErrorUrl = null;
const managedAgent = { child: null, deviceId: null, executable: null, identityFile: null,
  state: "unavailable", mode: "update_enabled", error: null, pairing: null };
let agentSwitch = null;
const activationScreen = () => app.isPackaged ? path.join(process.resourcesPath, "activation.html") : path.join(__dirname, "activation.html");
const activationFile = () => path.join(app.getPath("userData"), "license-activation.bin");
const verifierFile = () => app.isPackaged ? path.join(process.resourcesPath, "license-verifier.json") : path.join(__dirname, "license-verifier.json");
function isActivationScreenUrl(value) {
  try { return path.resolve(fileURLToPath(value)) === path.resolve(activationScreen()); }
  catch { return false; }
}

function verifier() { return license.readManifest(fs.readFileSync(verifierFile(), "utf8")); }
function savedActivation() {
  if (!fs.existsSync(activationFile())) throw new Error("Enter a valid license key to activate UpdateX.");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable for this user.");
  try {
    const record = JSON.parse(safeStorage.decryptString(fs.readFileSync(activationFile())));
    return license.validateActivation(record, verifier(), license.deviceFingerprint());
  } catch { throw new Error("Saved activation is invalid or damaged. Enter a valid license key again."); }
}
function saveActivation(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable for this user.");
  const record = license.activate(key, verifier(), license.deviceFingerprint());
  fs.mkdirSync(path.dirname(activationFile()), { recursive: true });
  fs.writeFileSync(activationFile(), safeStorage.encryptString(JSON.stringify(record)), { mode: 0o600 });
  return record;
}
async function showActivation(message = "") {
  await mainWindow.loadFile(activationScreen(), { query: { message } });
  mainWindow.show();
}

app.setName("UpdateX");
// Electron defaults userData to roaming AppData. Keep the desktop profile,
// encrypted license and session cookies beside the per-user SQLite database.
const legacyUserData = app.getPath("userData");
const localUserData = path.join(process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local"), "UpdateX");
let profileStorageError = null;
if (path.resolve(legacyUserData) !== path.resolve(localUserData)) {
  try {
    fs.mkdirSync(localUserData, { recursive: true });
    if (fs.existsSync(legacyUserData)) {
      for (const name of fs.readdirSync(legacyUserData)) {
        const destination = path.join(localUserData, name);
        if (!fs.existsSync(destination)) fs.cpSync(path.join(legacyUserData, name), destination, { recursive: true });
      }
    }
    app.setPath("userData", localUserData);
  } catch {
    // Keep the old profile intact and refuse packaged startup. A partial copy
    // must never silently hide the previous license or account session.
    app.setPath("userData", legacyUserData);
    profileStorageError = "UpdateX could not move its existing profile into this Windows user's local app data folder. The old files remain intact; check folder permissions and free space before reopening.";
  }
}

function logStartup(event, code = null) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "desktop-startup.log"),
      JSON.stringify({ time: new Date().toISOString(), event, code }) + "\n");
  } catch { /* Startup must not depend on diagnostic logging. */ }
}

function appIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "branding", "UpdateX_App_Icon.ico")
    : path.join(__dirname, "..", "branding", "UpdateX_App_Icon.ico");
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function isLocalAppUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === origin;
  } catch {
    return false;
  }
}

function validSender(event) {
  return mainWindow && !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    isLocalAppUrl(event.senderFrame?.url);
}

function windowCommand(name, action) {
  ipcMain.handle(name, event => {
    if (!validSender(event)) throw new Error("Window action rejected.");
    action();
  });
}

async function chooseEnvFile() {
  const configFile = path.join(app.getPath("userData"), "database-env-path.txt");
  const configured = process.env.UPDATEPILOT_ENV_FILE ||
    (fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8").trim() : "");
  if (configured && fs.existsSync(configured)) return configured;
  const choice = await dialog.showOpenDialog({
    title: "Select your existing UpdateX database .env file",
    buttonLabel: "Use database configuration",
    properties: ["openFile"],
  });
  if (choice.canceled || !choice.filePaths[0]) return null;
  const selected = choice.filePaths[0];
  fs.writeFileSync(configFile, selected, { encoding: "utf8", mode: 0o600 });
  return selected;
}

function packagedDatabaseProfile(resources) {
  const profile = path.join(resources, "database-profile.json");
  if (!fs.existsSync(profile)) return "postgresql";
  try {
    const value = JSON.parse(fs.readFileSync(profile, "utf8"));
    if (value.format === 1 && value.provider === "sqlite") return "sqlite";
  } catch { /* An invalid marker cannot safely select a database. */ }
  throw new Error("The packaged database profile is invalid.");
}

function startupFailureCode(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof value.code === "string" && /^[A-Z_]+$/.test(value.code) ? value.code : null;
  } catch { return null; }
}

function sqliteStartupMessage(code) {
  const messages = {
    SQLITE_DATABASE_MISSING: "UpdateX could not create its local database. Check access to this Windows user's local app data folder.",
    SQLITE_DATABASE_LOCKED: "The UpdateX database is in use or a previous startup lock could not be safely recovered. Close other UpdateX instances and retry.",
    SQLITE_DATABASE_CORRUPT: "The local UpdateX database failed its integrity check. Keep the database and backups; recovery needs your review.",
    SQLITE_SCHEMA_INCOMPATIBLE: "The local UpdateX database schema is not compatible with this app version. Keep the database and use a compatible UpdateX build.",
    SQLITE_MIGRATION_FAILED: "A database upgrade failed. UpdateX retained its backup and did not start the agent. Review the startup log before retrying.",
    SQLITE_BACKUP_FAILED: "UpdateX could not back up its database, so no upgrade was applied. Check free space and folder access.",
    LOCAL_PORT_IN_USE: "A local service is already using the UpdateX API port. Close the conflicting service and reopen UpdateX.",
  };
  return messages[code] || null;
}

async function reachable(url) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.ok; }
  catch { return false; }
}

async function apiReadiness() {
  try {
    const response = await fetch(`${apiOrigin}/ready`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, code: body?.code ?? null, license: body?.license ?? null,
      database: body?.database ?? null };
  } catch { return { ok: false, code: null, license: null, database: null }; }
}

function apiStartupMessage(state) {
  if (state.code === "DATABASE_SCHEMA_OUTDATED")
    return "The local PostgreSQL schema is older than this UpdateX build. Review and apply the pending Prisma migrations manually; your existing data will be preserved.";
  if (state.code === "DATABASE_CONNECTION_FAILED")
    return "UpdateX cannot use the configured local PostgreSQL connection. Check the selected .env file and database service.";
  if (state.code === "LICENSE_REQUIRED")
    return "The running local API has no valid offline license configuration. Close the older services and reopen UpdateX.";
  return null;
}

async function waitForApiReady(durationMs, statusFile = null) {
  const deadline = Date.now() + durationMs;
  let state = await apiReadiness();
  while (!state.ok && Date.now() < deadline) {
    const failure = statusFile ? startupFailureCode(statusFile) : null;
    if (failure) return { ok: false, code: failure, license: null };
    if (state.code === "DATABASE_SCHEMA_OUTDATED" || state.code === "LICENSE_REQUIRED") return state;
    await new Promise(resolve => setTimeout(resolve, 500));
    state = await apiReadiness();
  }
  return state;
}

function startChild(label, executable, args, options) {
  const child = spawn(executable, args, { windowsHide: true, stdio: "ignore", ...options });
  logStartup(`${label}_spawned`, child.pid ?? null);
  child.on("error", error => logStartup(`${label}_error`, error.code ?? "UNKNOWN"));
  child.on("exit", code => logStartup(`${label}_exit`, code));
  children.push(child);
  return child;
}

async function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function pairedDeviceId(identityFile) {
  try {
    const value = JSON.parse(fs.readFileSync(identityFile, "utf8")).DeviceId;
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
  } catch { return null; }
}

function managedAgentStatus(includePairing = false) {
  return { managed: Boolean(managedAgent.deviceId && managedAgent.executable), deviceId: managedAgent.deviceId,
    processState: managedAgent.state, launchMode: managedAgent.mode, error: managedAgent.error,
    pairing: includePairing ? managedAgent.pairing : null };
}

function capturePairingOutput(child) {
  let pending = "";
  let code = null;
  let fingerprint = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    pending = (pending + chunk).slice(-4096);
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      const foundCode = /^Code: ([A-Z2-9]{6}-[A-Z2-9]{6})$/.exec(line);
      const foundFingerprint = /^Key fingerprint: ([a-f0-9]{64})$/.exec(line);
      if (foundCode) code = foundCode[1];
      if (foundFingerprint) fingerprint = foundFingerprint[1];
      if (code && fingerprint && managedAgent.child === child) {
        managedAgent.pairing = { code, fingerprint, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
        managedAgent.state = "pairing";
      }
      if (line === "Agent paired. The first scan is queued." && managedAgent.child === child) {
        managedAgent.deviceId = pairedDeviceId(managedAgent.identityFile);
        managedAgent.pairing = null;
        managedAgent.state = managedAgent.deviceId ? "running" : "error";
      }
    }
  });
}

async function launchManagedAgent(firstPairing = false) {
  if (!managedAgent.executable || (!managedAgent.deviceId && !firstPairing))
    throw new Error("No desktop-managed agent is available.");
  if (managedAgent.child && managedAgent.child.exitCode === null && managedAgent.child.signalCode === null)
    throw new Error("The previous desktop-managed agent is still running. No duplicate agent was started.");
  const child = spawn(managedAgent.executable, ["--allow-updates"], {
    cwd: path.dirname(managedAgent.executable), env: process.env, windowsHide: true,
    stdio: firstPairing ? ["ignore", "pipe", "ignore"] : "ignore",
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  managedAgent.child = child;
  managedAgent.mode = "update_enabled";
  managedAgent.state = firstPairing ? "pairing" : "running";
  managedAgent.error = null;
  managedAgent.pairing = null;
  if (firstPairing) capturePairingOutput(child);
  logStartup("agent_update_enabled_spawned", child.pid ?? null);
  child.on("error", error => {
    logStartup("managed_agent_error", error.code ?? "UNKNOWN");
    if (managedAgent.child === child) {
      managedAgent.state = "error";
      managedAgent.error = "The Windows agent encountered a process error. Check its connection and try again.";
    }
  });
  child.on("exit", code => {
    logStartup("managed_agent_exit", code);
    if (managedAgent.child === child) {
      managedAgent.child = null;
      managedAgent.pairing = null;
      managedAgent.state = code === 3 && !app.isPackaged ? "external_services" : code === 0 ? "stopped" : "error";
      managedAgent.error = code === 0 ? null : code === 3
        ? "Another UpdateX agent is running for this Windows user. Close that agent, then use Restart agent in Settings to launch the update-capable agent."
        : firstPairing ? "Pairing expired or the agent stopped. Restart it in Settings."
          : "The Windows agent stopped unexpectedly. Check its connection and try again.";
    }
  });
}

async function stopManagedAgent() {
  const child = managedAgent.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    managedAgent.child = null;
    return;
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener("exit", exited); reject(new Error("The previous agent did not stop. No replacement was started.")); }, 10000);
    const exited = () => { clearTimeout(timer); resolve(); };
    child.once("exit", exited);
    if (!child.kill()) { clearTimeout(timer); child.removeListener("exit", exited); reject(new Error("Could not stop the previous agent. No replacement was started.")); }
  });
  managedAgent.child = null;
}

async function requireOwnerSession() {
  const cookies = await session.defaultSession.cookies.get({ url: origin, name: "up_session" });
  const cookie = cookies.find(item => item.name === "up_session");
  if (!cookie) throw new Error("Choose Guest or sign in before managing this device.");
  const response = await fetch(`${apiOrigin}/auth/state`, { headers: { Cookie: `up_session=${cookie.value}` },
    cache: "no-store", signal: AbortSignal.timeout(6000) });
  if (!response.ok || (await response.json()).authenticated !== true)
    throw new Error("The local session could not be verified. Choose Guest or sign in again.");
  return cookie.value;
}

async function requireAllJobsIdle() {
  const cookie = await requireOwnerSession();
  const headers = { Cookie: `up_session=${cookie}` };
  const response = await fetch(`${apiOrigin}/devices`, { headers, cache: "no-store", signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error("Could not check device jobs before deactivation.");
  const devices = await response.json();
  if (!Array.isArray(devices.items)) throw new Error("Device activity response was invalid.");
  for (const device of devices.items) {
    if (device.revokedAt) continue;
    const activityResponse = await fetch(`${apiOrigin}/devices/${encodeURIComponent(device.id)}/activity`,
      { headers, cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!activityResponse.ok) throw new Error("Could not check all device jobs before deactivation.");
    requireIdleAgent(await activityResponse.json());
  }
}

function requireIdleAgent(activity) {
  if (activity.activeUpdates > 0 || activity.activeScans > 0)
    throw new Error(`Action blocked: ${activity.activeScans} scan job(s) and ${activity.activeUpdates} update job(s) are pending or running. Wait for them to finish, or cancel a queued update.`);
}

async function waitFor(url, durationMs) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function startPackagedServices() {
  if (!app.isPackaged) return null;
  logStartup("packaged_start");
  const resources = path.join(process.resourcesPath, "services");
  const provider = packagedDatabaseProfile(resources);
  const startupGate = createStartupGate();
  const started = [];
  const fail = message => { stopStartedServices(started); return message; };
  const initialApi = await apiReadiness();
  const initialApiError = apiStartupMessage(initialApi);
  if (initialApiError) return provider === "sqlite"
    ? "Another local API is using the UpdateX port but is not ready for this SQLite build. Close that service and reopen UpdateX."
    : initialApiError;
  const apiReady = initialApi.ok;
  const webReady = await reachable(origin + "/overview");
  if (provider === "sqlite" && (apiReady || webReady || !await portAvailable(4000) || !await portAvailable(3000)))
    return "A local API or web port is occupied. Close the conflicting service before reopening this SQLite installation; UpdateX will not attach to another process.";
  if (apiReady && webReady) {
    if (initialApi.license !== "offline_key_verified_v1") return "The running local API does not enforce direct offline key licensing. Close the older services and reopen UpdateX.";
    if (initialApi.database !== provider && !(provider === "postgresql" && initialApi.database === null))
      return "The running local API uses a different database profile. Close the other UpdateX services before opening this build.";
    managedAgent.state = "external_services"; logStartup("existing_services_ready"); return null;
  }
  if (apiReady !== webReady) return "One local service is already using an UpdateX port. Close it or start both development services.";
  const apiFile = path.join(resources, "api", "dist", "server.js");
  const webFile = path.join(resources, "web", "node_modules", "next", "dist", "bin", "next");
  const agentFile = path.join(resources, "agent", "UpdateX.Agent.exe");
  if (missingRuntimeAssets(resources, provider).length)
    return "Packaged UpdateX runtime assets are missing. Rebuild the installer from the complete production outputs.";
  let commonEnv;
  let statusFile = null;
  if (provider === "sqlite") {
    const legacyConfig = path.join(app.getPath("userData"), "database-env-path.txt");
    if (process.env.UPDATEPILOT_ENV_FILE || fs.existsSync(legacyConfig))
      return "An existing PostgreSQL configuration was found. UpdateX will not create a new SQLite inventory over it. Use the PostgreSQL build until you explicitly import your data.";
    statusFile = path.join(app.getPath("userData"), `api-startup-${process.pid}-${Date.now()}.json`);
    commonEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production",
      UPDATE_X_DB_PROVIDER: "sqlite", DATABASE_URL: sqliteFileUrl(sqliteDatabasePath()),
      UPDATE_X_SQLITE_MIGRATIONS_DIR: path.join(resources, "api", "migrations", "sqlite"),
      UPDATE_X_STARTUP_STATUS_FILE: statusFile };
    delete commonEnv.UPDATEPILOT_ENV_FILE;
  } else {
    const envFile = await chooseEnvFile();
    if (!envFile) return "Select your existing local database .env file to start UpdateX. No credentials are stored in the installer.";
    logStartup("database_configuration_selected");
    commonEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", UPDATEPILOT_ENV_FILE: envFile,
      UPDATE_X_DB_PROVIDER: "postgresql", NODE_ENV: "production" };
    delete commonEnv.DATABASE_URL;
  }
  const activeLicense = savedActivation();
  const apiEnv = { ...commonEnv,
    UPDATE_X_PACKAGED_API: "1",
    UPDATE_X_LICENSE_HASH: activeLicense.keyHash,
    UPDATE_X_LICENSE_ACTIVATED_AT: activeLicense.activatedAt,
    UPDATE_X_LICENSE_DEVICE_ID: activeLicense.device,
    UPDATE_X_LICENSE_VERIFIER_FILE: verifierFile() };
  started.push(startChild("api", process.execPath, [apiFile], { cwd: path.dirname(apiFile), env: apiEnv }));
  const apiState = await waitForApiReady(60000, statusFile);
  if (!apiState.ok) return fail(sqliteStartupMessage(apiState.code) ?? apiStartupMessage(apiState) ??
    (provider === "sqlite" ? "The local SQLite API could not become ready. Check the UpdateX startup log."
      : "The local API could not become ready. Check the selected .env file and PostgreSQL service."));
  if (apiState.license !== "offline_key_verified_v1" || apiState.database !== provider)
    return fail("The local API reported an incompatible license or database profile. Packaged services were stopped.");
  startupGate.apiReady(apiState.database, provider);
  logStartup("api_ready");
  if (!await portAvailable(3000)) return fail("The web port became occupied during startup. UpdateX stopped only its own API process.");
  started.push(startChild("web", process.execPath, [webFile, "start", "--hostname", "127.0.0.1", "--port", "3000"], { cwd: path.join(resources, "web"), env: commonEnv }));
  if (!await waitFor(origin + "/overview", 60000)) return fail("The packaged web application did not start. UpdateX stopped only its own service processes.");
  startupGate.webReady();
  logStartup("web_ready");
  const agentIdentity = path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "UpdateX", "agent.json");
  managedAgent.identityFile = agentIdentity;
  managedAgent.executable = fs.existsSync(agentFile) ? agentFile : null;
  managedAgent.deviceId = pairedDeviceId(agentIdentity) ?? pairedDeviceId(path.join(
    process.env.LOCALAPPDATA || app.getPath("userData"), "UpdatePilot", "agent.json"));
  startupGate.agentAllowed();
  if (managedAgent.executable) {
    try { await launchManagedAgent(!managedAgent.deviceId); }
    catch {
      managedAgent.state = "error";
      managedAgent.error = "The Windows agent could not start. Check the bundled agent and try again.";
    }
  } else {
    managedAgent.state = "unavailable";
    managedAgent.error = "The bundled Windows agent is missing.";
  }
  return null;
}

async function startDevelopmentAgent() {
  const agentFile = path.join(__dirname, "..", "apps", "agent-windows", "bin", "Debug", "net10.0-windows", "UpdateX.Agent.exe");
  const agentIdentity = path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "UpdateX", "agent.json");
  managedAgent.identityFile = agentIdentity;
  managedAgent.executable = fs.existsSync(agentFile) ? agentFile : null;
  managedAgent.deviceId = pairedDeviceId(agentIdentity) ?? pairedDeviceId(path.join(
    process.env.LOCALAPPDATA || app.getPath("userData"), "UpdatePilot", "agent.json"));
  if (!managedAgent.executable) {
    managedAgent.state = "unavailable";
    managedAgent.error = "Build the Windows agent before starting the development desktop window.";
    return;
  }
  const apiState = await apiReadiness();
  if (!apiState.ok || apiState.license !== "offline_key_verified_v1" || !await reachable(origin + "/overview")) {
    managedAgent.state = "unavailable";
    managedAgent.error = "The local licensed API and web app must be ready before the development agent can start.";
    return;
  }
  try { await launchManagedAgent(!managedAgent.deviceId); }
  catch (error) {
    managedAgent.state = "error";
    managedAgent.error = error.message;
  }
}

function showLocalError(message) {
  const safe = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  internalErrorUrl = "data:text/html;charset=utf-8," + encodeURIComponent(
    `<body style="background:#242424;color:#f5f5f5;font:14px Segoe UI;padding:32px"><h1>UpdateX local service unavailable</h1><p>${safe}</p></body>`
  );
  logStartup("local_error_screen");
  return mainWindow.loadURL(internalErrorUrl);
}

if (primaryInstance) app.whenReady().then(async () => {
  if (process.platform === "win32") app.setAppUserModelId("com.updatex.desktop");
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  windowCommand("window:minimize", () => mainWindow.minimize());
  windowCommand("window:toggle-maximize", () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
  windowCommand("window:close", () => mainWindow.close());
  ipcMain.handle("agent:status", event => {
    if (!validSender(event)) throw new Error("Agent status request rejected.");
    const settingsPage = new URL(event.senderFrame.url).pathname === "/settings";
    return managedAgentStatus(settingsPage);
  });
  ipcMain.handle("agent:restart", async event => {
    if (!validSender(event) || new URL(event.senderFrame.url).pathname !== "/settings")
      throw new Error("Agent restart request rejected.");
    const ownerCookie = await requireOwnerSession();
    if (!managedAgent.executable)
      throw new Error("The bundled Windows agent is unavailable in this desktop session.");
    if (agentSwitch) throw new Error("An agent change is already in progress.");
    agentSwitch = (async () => {
      if (managedAgent.child && managedAgent.child.exitCode === null && managedAgent.child.signalCode === null)
        return managedAgentStatus(true);
      managedAgent.deviceId = pairedDeviceId(managedAgent.identityFile) ?? managedAgent.deviceId;
      if (!managedAgent.deviceId) {
        const response = await fetch(`${apiOrigin}/devices`, { headers: { Cookie: `up_session=${ownerCookie}` },
          cache: "no-store", signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw new Error("Could not check paired devices before starting the agent.");
        const devices = await response.json();
        if (!Array.isArray(devices.items)) throw new Error("The paired-device response was invalid.");
        if (devices.items.some(device => !device.revokedAt))
          throw new Error("A device is already paired, but this Windows user's agent identity is unavailable. Use agent key recovery in Settings; UpdateX will not create a duplicate device.");
      }
      try { await launchManagedAgent(!managedAgent.deviceId); }
      catch (error) {
        managedAgent.state = "error";
        managedAgent.error = error.message;
        throw error;
      }
      return managedAgentStatus(true);
    })();
    return agentSwitch.finally(() => { agentSwitch = null; });
  });
  ipcMain.handle("store:open-updates", async event => {
    if (!validSender(event)) throw new Error("Store action rejected.");
    await shell.openExternal("ms-windows-store://downloadsandupdates");
  });
  ipcMain.handle("store:open-product", async (event, packageFamilyName) => {
    if (!validSender(event)) throw new Error("Store action rejected.");
    if (typeof packageFamilyName !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(packageFamilyName) ||
        !packageFamilyName.includes("_")) throw new Error("Invalid Windows package identity.");
    await shell.openExternal("ms-windows-store://pdp/?PFN=" + encodeURIComponent(packageFamilyName));
  });
  ipcMain.handle("license:activate", async (event, key) => {
    if (event.sender !== mainWindow.webContents || !isActivationScreenUrl(event.senderFrame?.url))
      throw new Error("License activation rejected.");
    saveActivation(String(key ?? ""));
    const startupError = await startPackagedServices();
    if (startupError) { await showLocalError(startupError); return { activated: true, startupError }; }
    await mainWindow.loadURL(origin + "/login");
    return { activated: true };
  });
  ipcMain.handle("license:status", event => {
    if (!validSender(event)) throw new Error("License status request rejected.");
    try { const value = savedActivation(); return { activated: true, maskedIdentifier: value.maskedIdentifier,
      activatedAt: value.activatedAt, device: value.device }; }
    catch (error) { return { activated: false, error: error.message }; }
  });
  ipcMain.handle("license:change", async (event, key) => {
    if (!validSender(event)) throw new Error("License change rejected.");
    await requireAllJobsIdle();
    saveActivation(String(key ?? ""));
    setTimeout(() => { app.relaunch(); app.quit(); }, 100);
    return { changed: true };
  });
  ipcMain.handle("license:deactivate", async event => {
    if (!validSender(event)) throw new Error("Deactivation request rejected.");
    await requireAllJobsIdle();
    if (fs.existsSync(activationFile())) fs.unlinkSync(activationFile());
    setTimeout(() => { app.relaunch(); app.quit(); }, 100);
    return { deactivated: true };
  });
  mainWindow = new BrowserWindow({
    title: "UpdateX",
    icon: appIconPath(),
    width: 980,
    height: 650,
    minWidth: 760,
    minHeight: 480,
    show: false,
    frame: false,
    backgroundColor: "#242424",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  if (app.isPackaged) {
    setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed() || isActivationScreenUrl(mainWindow.webContents.getURL())) return;
      try { savedActivation(); }
      catch (error) { void showActivation(error.message); }
    }, 15000).unref();
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/github\.com\/(?:obsproject\/obs-studio|telegramdesktop\/tdesktop|git-for-windows\/git)\/releases\/tag\/[A-Za-z0-9._+%-]+$/.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isLocalAppUrl(url) && url !== internalErrorUrl && !isActivationScreenUrl(url)) event.preventDefault();
  });
  tray = new Tray(appIconPath());
  tray.setToolTip("UpdateX");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open UpdateX", click: () => { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } },
    { type: "separator" },
    { label: "Quit UpdateX", click: () => app.quit() },
  ]));
  tray.on("double-click", () => { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  try {
    if (app.isPackaged) await mainWindow.loadFile(path.join(process.resourcesPath, "splash.html"));
    if (app.isPackaged && profileStorageError) { await showLocalError(profileStorageError); return; }
    if (app.isPackaged) {
      try { savedActivation(); }
      catch (error) { await showActivation(error.message); return; }
    }
    const startupError = await startPackagedServices();
    if (startupError) { logStartup("startup_failed"); await showLocalError(startupError); mainWindow.show(); return; }
    if (!app.isPackaged) await startDevelopmentAgent();
    await mainWindow.loadURL(origin + "/login");
    logStartup("window_loaded");
  } catch (error) {
    logStartup("startup_exception", error.code ?? error.name ?? "UNKNOWN");
    // Services must already be running. A local error view is safer than loading
    // a remote fallback into this privileged application window.
    await showLocalError("Start the local licensed API and web app, then reopen UpdateX.");
    mainWindow.show();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { for (const child of children) if (!child.killed) child.kill(); });
