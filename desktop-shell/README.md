# UpdateX Windows desktop package

The Electron shell uses the supplied UpdateX icon and logo. It validates one of the existing 50 license keys directly and offline against a packaged hash-only verifier. A valid key is required before the shell starts its local API, web interface, or managed Windows agent. First activation opens Welcome with Sign In, Sign Up, and Continue as Guest. Later launches restore a remembered account session or Guest choice. The managed agent starts update-capable, including first pairing. Every update still requires an exact package review and explicit confirmation.

**Phase 3 source-only status:** The SQLite self-contained packaging changes have not been built, tested, installed, or launched. See [Phase 3 packaging and clean-PC verification](../docs/SQLITE_PHASE_3_PACKAGING.md). The installer License Agreement page is still pending owner approval of [the draft agreement](../docs/DRAFT_UPDATEX_LICENSE_AGREEMENT.md). The existing 50 keys were not activated or copied as raw strings into the application.

## Manual build

The `desktop-shell/license-verifier.json` file is derived from the owner's existing CSV and contains only SHA-256 hashes. See [direct offline licensing](../docs/OFFLINE_LICENSE_WORKFLOW.md). Do not package the CSV or database `.env`. Review the additive migration in [guest access](../docs/LICENSE_FIRST_GUEST_ACCESS.md) before applying it. From the project root in PowerShell:

Follow the SQLite-specific manual commands in [the Phase 3 guide](../docs/SQLITE_PHASE_3_PACKAGING.md). Do not use the former PostgreSQL migration and framework-dependent agent commands for a new SQLite installer.

The output is under `.local/desktop-dist` after packaging succeeds. New SQLite installations do not require PostgreSQL. An explicitly built legacy PostgreSQL profile still uses the existing local database and requests its `.env` path. The agent starts update-capable when the packaged desktop app starts. A Guest or account user still has to review and explicitly confirm each real update. No update is queued by opening the app.

For development, start the licensed local API and web app first, then run `pnpm --dir .\desktop-shell start`. The Electron development window starts the project-local Debug agent with update capability. If a separately started agent already owns this Windows user's agent mutex, UpdateX leaves that process untouched and shows its actual API-reported capability. Close the old agent yourself, then use **Start agent** in Settings. Do not restart the agent while a confirmed update job is pending unless you intend that job to run.

The License Agreement page can be added only after the owner approves final text. Save approved plain text as `desktop-shell/license.txt` and add `"license": "license.txt"` to the `nsis` block in `electron-builder.json`. The draft is not bundled.

If services already occupy both local ports, the shell uses them only if the API reports a verified offline license. Older unlicensed API builds are rejected. Restart web and API services after rebuilding so their routes agree.
