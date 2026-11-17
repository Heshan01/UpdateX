import { cp, lstat, mkdir, readlink, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stagePrismaClient, validatePrismaClient } from "./prisma-stage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, ".local", "desktop-stage");
const allowed = path.join(root, ".local") + path.sep;
if (!stage.startsWith(allowed)) throw new Error("Packaging stage escaped the local workspace.");
const agent = path.join(root, "apps", "agent-windows", "bin", "Release", "net10.0-windows", "publish");
for (const source of [path.join(root, "apps", "web", ".next", "BUILD_ID"),
  path.join(agent, "UpdateX.Agent.exe"), path.join(agent, "UpdateX.Agent.runtimeconfig.json"),
  path.join(agent, "coreclr.dll"), path.join(agent, "hostfxr.dll"), path.join(agent, "hostpolicy.dll"),
  path.join(agent, "ReadWinGet.ps1"), path.join(agent, "ReadWindowsApps.ps1")]) {
  await stat(source).catch(() => { throw new Error(`Build output missing: ${source}. Run pnpm build and dotnet publish first.`); });
}
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(agent, path.join(stage, "agent"), { recursive: true });
const moduleSource = path.join(root, ".local", "modules", "Microsoft.WinGet.Client");
if (!await stat(path.join(moduleSource, "1.29.380", "Microsoft.WinGet.Client.psd1")).catch(() => null))
  throw new Error("The bundled Microsoft.WinGet.Client module is missing; package staging cannot provide trusted update detection.");
await cp(moduleSource, path.join(stage, "agent", "modules", "Microsoft.WinGet.Client"), { recursive: true });
for (const [name, target] of [["@updatepilot/api", "api"], ["@updatepilot/web", "web"]]) {
  const deployArgs = ["--filter", name, "deploy", "--legacy", "--prod", "--config.node-linker=hoisted", path.join(stage, target)];
  const deployed = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...deployArgs], { cwd: root, stdio: "inherit" })
    : spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", deployArgs, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (deployed.status !== 0) throw new Error(`${name} packaging failed with exit code ${deployed.status ?? "unknown"}.`);
  // Hoisted deployment materializes dependencies, but pnpm may add links back to
  // workspace entry points. They are not runtime dependencies of the staged app.
  for (const [packageName, expected] of [
    ["api", path.join(root, "apps", "api")],
    ["web", path.join(root, "apps", "web")],
    ["contracts", path.join(root, "packages", "contracts")],
    ["db", path.join(root, "packages", "db")],
  ]) {
    const link = path.join(stage, target, "node_modules", "@updatepilot", packageName);
    const info = await lstat(link).catch(() => null);
    if (!info?.isSymbolicLink()) continue;
    const destination = await readlink(link);
    if (path.resolve(destination) !== expected) {
      throw new Error(`Unexpected workspace link in ${target} deployment: ${link}`);
    }
    await rmdir(link);
  }
}
const requestedProvider = process.env.UPDATE_X_PACKAGE_DB_PROVIDER || "sqlite";
if (requestedProvider !== "sqlite" && requestedProvider !== "postgresql")
  throw new Error("UPDATE_X_PACKAGE_DB_PROVIDER must be sqlite or postgresql.");
const stagedDbEntry = path.join(stage, "api", "node_modules", "@updatepilot", "db", "dist", "index.js");
const stagedPrisma = await stagePrismaClient(path.join(root, "packages", "db", "dist", "index.js"),
  stagedDbEntry, requestedProvider, stage);
if (requestedProvider === "sqlite") {
  const migrationSource = path.join(root, "packages", "db", "prisma-sqlite", "migrations");
  const migrationTarget = path.join(stage, "api", "migrations", "sqlite");
  await cp(migrationSource, migrationTarget, { recursive: true });
  await writeFile(path.join(stage, "database-profile.json"), JSON.stringify({ provider: "sqlite", format: 1 }));
}
const nextOutput = path.join(root, "apps", "web", ".next");
const nextCache = path.join(nextOutput, "cache");
await cp(nextOutput, path.join(stage, "web", ".next"), { recursive: true,
  filter: source => source !== nextCache && !source.startsWith(nextCache + path.sep), });
const stagedNextCache = path.join(stage, "web", ".next", "cache");
if (!stagedNextCache.startsWith(stage + path.sep)) throw new Error("Next.js cache escaped the packaging stage.");
await rm(stagedNextCache, { recursive: true, force: true });
await cp(path.join(root, "apps", "web", "public"), path.join(stage, "web", "public"), { recursive: true });
// Documentation, source maps, and type declarations are not used by the packaged
// Node/Next runtimes. Keep executable JS, JSON, native binaries, and Prisma engines.
async function pruneRuntime(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await pruneRuntime(file); continue; }
    if (entry.isFile() && /(?:\.md|\.map|\.d\.ts|\.pdb)$/i.test(entry.name)) await rm(file);
  }
}
for (const target of [path.join(stage, "api", "node_modules"), path.join(stage, "web", "node_modules"), path.join(stage, "agent")])
  await pruneRuntime(target);
// A deployment must never carry a developer's credentials, local database,
// activation, or source license-key CSV. Refuse the package instead of silently
// shipping an accidentally copied file.
async function rejectPrivateFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await rejectPrivateFiles(file); continue; }
    if (/^(?:\.env(?:\..*)?|updatex\.db(?:-.*)?|license-activation\.bin|UpdateX_50_License_Keys\.csv)$/i.test(entry.name))
      throw new Error(`Private local data must not be packaged: ${file}`);
  }
}
await rejectPrivateFiles(stage);
const finalPrisma = await validatePrismaClient(stagedDbEntry, requestedProvider);
if (finalPrisma.schemaHash !== stagedPrisma.schemaHash || finalPrisma.engineHash !== stagedPrisma.engineHash)
  throw new Error("Final packaged API Prisma Client changed after staging.");
console.log(`Desktop services staged at ${stage}`);
