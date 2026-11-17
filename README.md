# UpdateX

**Source-only work pending manual verification:** The Downloads Manager, Windows app inventory, NSIS wizard options, and direct offline licensing have been edited but not built or tested. The installer License Agreement page awaits approval of [the draft agreement](docs/DRAFT_UPDATEX_LICENSE_AGREEMENT.md). [Offline license workflow](docs/OFFLINE_LICENSE_WORKFLOW.md) explains the existing 50-key verifier and direct activation. No replacement keys were generated.

The current API source enforces a valid local key activation on every request except its local health check. Starting only the web/API development servers without the licensed desktop shell's activation configuration will show a license-required error; this is intentional. Existing running binaries retain their previous behavior until manually rebuilt and restarted.

UpdateX (formerly UpdatePilot) is a local Windows software inventory and update management MVP. Its Next.js dashboard, Express API and PostgreSQL database run on the same computer. A paired .NET agent reads installed applications and WinGet package data, then saves real snapshots through a signed API. The dashboard shows verified updates alongside explicit unknown, ambiguous and unsupported cases.

**Branding:** The supplied assets in `branding/` are used directly. The web app serves the full logo on authentication, loading and About views, and uses the supplied multi-size ICO for its favicon and compact titlebar mark. The supplied `UpdateX_App_Icon_512.png` is preserved as provided; despite its filename, its actual dimensions are 1254×1254. The Electron shell source specifies the UpdateX title, window/tray icon, installer and shortcut names. Internal `@updatepilot/*` package names, the `updatepilot` database name, agent key/storage names, and existing project filenames are retained to protect compatibility with existing data and pairing. See [branding and compatibility](docs/BRANDING.md).

**Inventory correction:** three real read-only scans each produced 192 raw observations and 157 logical applications, with 11 distinct available package IDs. Original snapshots remain in history. See [inventory identity evidence](docs/INVENTORY_IDENTITY.md).

**Current milestone:** License-first, account-optional Guest access has been added; see [access changes](docs/LICENSE_FIRST_GUEST_ACCESS.md). Saved inventory and history remain available while the agent is offline. Applications and update-job history export to CSV. Application detail checks exact official release metadata for a small verified set of WinGet IDs and clearly shows unavailable information otherwise. Settings let the local user choose when to label a saved scan old; all records remain retained. **No real software update has been executed or verified.** A licensed, paired agent starts ready for confirmed updates. Every package still requires preview and explicit confirmation.

## Stack and layout

- `apps/web`: Next.js 15, TypeScript, Tailwind CSS
- `apps/api`: Express, TypeScript, offline license gate, local Guest/account sessions and signed agent routes
- `apps/agent-windows`: .NET 10 per-user Windows agent
- `desktop-shell`: Electron Windows shell and packaging source; installer status is in the final feature report
- `packages/contracts`: shared TypeScript DTOs and Zod request schemas
- `packages/db`: PostgreSQL, Prisma schema and migrations
- `docs`: architecture, API, setup, plan and testing evidence

## Run locally

Use Windows 10/11 with WinGet, Node.js 22+, pnpm 11, .NET 10 SDK and the locally installed PostgreSQL service at `127.0.0.1:5432` with database `updatepilot`. Docker is not required. From the repository root:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
powershell -NoProfile -File .\scripts\set-db-password.ps1
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Enter the database password only at the script's hidden local prompt. The ignored `.env` is never committed. Open `http://127.0.0.1:3000` and sign in as the local owner. The API binds to `127.0.0.1:4000`.

After offline license activation, Welcome offers **Sign In**, **Sign Up**, and **Continue as Guest**. Guest enters Scan directly without a username or password. Local accounts share this computer's inventory and history; passwords are bcrypt-hashed and account sessions remain signed in for up to 30 days unless signed out. Guest choice resumes across restarts. The first workspace page is **Scan**. Its central button queues a real read-only scan when the paired Windows agent is online. Applications, Updates, Downloads and History are available in Guest or Account mode, including while the agent is offline; saved results show their scan time and stale/offline context. The scan view shows queued/running/completed/failed states without invented percentages. Opening or refreshing the page does not start a scan automatically. The charcoal/red design is the default desktop visual language. The scan covers installed applications, not Windows device drivers.

The optional `scripts/launch-desktop-window.ps1` opens the already running local app in a Microsoft Edge app window with no URL bar or tabs. This is a preview window, **not** a packaged standalone release. The Electron window and packaging source are in [desktop-shell](desktop-shell/README.md). The script does not install anything or start update execution.

In another PowerShell window, obtain the official WinGet client module in the ignored project-local directory, then launch the agent **without** the update switch:

```powershell
powershell -NoProfile -File .\scripts\setup-winget-client.ps1
.\.local\dotnet-sdk\dotnet.exe run --project .\apps\agent-windows\UpdatePilot.Agent.csproj -- --scan-local
.\.local\dotnet-sdk\dotnet.exe run --project .\apps\agent-windows\UpdatePilot.Agent.csproj
```

The first command needs internet access to PowerShell Gallery. The local diagnostic scan is read-only. The persistent agent prints a short pairing code and key fingerprint on first run; enter the code in Settings, compare the fingerprint, and approve. The Scan page or Settings can queue another scan. Its signed heartbeat reports update capability and connection time. Keep the agent console running for connectivity; closing it marks the device offline after the heartbeat window. A previously confirmed queued update may execute when the agent connects. A queued update can be cancelled before claim and expires after 15 minutes without a claim. A claimed update with an expired lease becomes `execution_unknown`, never automatically queued for a second installation. A Windows sandbox that blocks packaged COM activation may prevent WinGet queries; run the agent in your normal Windows user session. In that case, the API labels WinGet results unavailable rather than inventing updates.

To rotate or recover a missing agent signing key, stop the old agent, then run the agent with `--rotate-key` or `--recover-key`. Key recovery cannot execute update jobs. Wait until the old device shows offline in Settings, select that device, compare the new fingerprint with the agent console, and approve the new code. The old key is invalidated while the existing device, inventory and history remain. Do not delete the old agent configuration or database rows as a recovery shortcut.

Detailed instructions and recovery notes: [Local setup](docs/SETUP.md). API routes: [API contract](docs/API.md). Design and remaining scope: [Architecture](docs/ARCHITECTURE.md), [Implementation plan](docs/IMPLEMENTATION_PLAN.md).

## Quality checks

```powershell
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
.\.local\dotnet-sdk\dotnet.exe build .\apps\agent-windows\UpdatePilot.Agent.csproj
```

`pnpm test` runs API and .NET resolver tests on Windows. `pnpm test:e2e` requires a prior `pnpm build` and the Playwright Chromium headless runtime. It starts a temporary production web server on `127.0.0.1:3100`, routes its API rewrite to a test-only guard on `127.0.0.1:49999`, intercepts every API request with fixtures, and stops both servers afterward. It does not connect to the owner's PostgreSQL database or run an update. To install only the required Chromium headless browser runtime in the ignored project directory on a fresh checkout:

```powershell
New-Item -ItemType Directory -Force .\.local | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Resolve-Path .\.local).Path 'playwright-browsers'
pnpm --filter @updatepilot/web exec playwright install --only-shell chromium
```

Stop running API processes before `pnpm build` because Prisma cannot replace its native client DLL while Node has it loaded. The API development watcher serves compiled JavaScript; rebuild the API after TypeScript edits. Current measured results and limitations are in [Testing report](docs/TESTING_REPORT.md).

## Safety boundary

The browser sends no shell text, executable path, installer URL or arbitrary WinGet flags. Owner actions require a session and CSRF token; the agent signs requests with a per-user Windows CNG key. A preview expires, confirmation names an exact package and target, and the agent independently rechecks package evidence before a fixed WinGet invocation. Automatic agreement acceptance, installer hash bypass and silent elevation are not enabled. Success requires an observed post-update target version. A real update requires the user's separate explicit approval.
