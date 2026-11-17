import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

// Resolve from @updatepilot/db, the package that actually imports Prisma at
// runtime. pnpm can keep a different generated client in each virtual store.
export function runtimePrismaPaths(dbEntry) {
  const fromDb = createRequire(dbEntry);
  const clientEntry = fromDb.resolve("@prisma/client");
  const packageJson = fromDb.resolve("@prisma/client/package.json");
  const generatedDirectory = path.resolve(path.dirname(clientEntry), "..", "..", ".prisma", "client");
  return { clientEntry, packageJson, generatedDirectory };
}

function providerFromSchema(schema) {
  const datasource = /datasource\s+db\s*\{([^}]*)\}/s.exec(schema)?.[1];
  return /\bprovider\s*=\s*"(sqlite|postgresql)"/.exec(datasource ?? "")?.[1] ?? null;
}

export async function validatePrismaClient(dbEntry, provider) {
  if (provider !== "sqlite" && provider !== "postgresql") throw new Error(`Unsupported Prisma provider: ${provider}`);
  const paths = runtimePrismaPaths(dbEntry);
  const runtimeEntry = createRequire(paths.clientEntry).resolve(".prisma/client/default");
  if (await realpath(path.dirname(runtimeEntry)) !== await realpath(paths.generatedDirectory))
    throw new Error("@prisma/client resolves a different generated runtime client.");
  const [schema, generated, manifest] = await Promise.all([
    readFile(path.join(paths.generatedDirectory, "schema.prisma"), "utf8"),
    readFile(path.join(paths.generatedDirectory, "index.js"), "utf8"),
    readFile(paths.packageJson, "utf8"),
  ]);
  const actualProvider = providerFromSchema(schema);
  if (actualProvider !== provider || !new RegExp(`"activeProvider"\\s*:\\s*"${provider}"`).test(generated))
    throw new Error(`Runtime Prisma Client provider mismatch: expected ${provider}, found ${actualProvider ?? "unknown"}. Generate with generate:${provider === "sqlite" ? "sqlite" : "postgres"}.`);
  const version = JSON.parse(manifest).version;
  if (!new RegExp(`"clientVersion"\\s*:\\s*"${version.replaceAll(".", "\\.")}"`).test(generated))
    throw new Error("Runtime Prisma Client version does not match @prisma/client.");
  const enginePath = path.join(paths.generatedDirectory, "query_engine-windows.dll.node");
  const engine = await open(enginePath, "r");
  let magic;
  try {
    magic = Buffer.alloc(2);
    await engine.read(magic, 0, 2, 0);
  } finally { await engine.close(); }
  if (magic.toString("ascii") !== "MZ") throw new Error("The Windows Prisma query engine is missing or invalid.");
  const engineHash = createHash("sha256").update(await readFile(enginePath)).digest("hex");
  return { ...paths, provider, version, schemaHash: createHash("sha256").update(schema).digest("hex"), engineHash };
}

export async function stagePrismaClient(sourceDbEntry, stagedDbEntry, provider, stageRoot) {
  const source = await validatePrismaClient(sourceDbEntry, provider);
  const target = runtimePrismaPaths(stagedDbEntry);
  const root = await realpath(stageRoot);
  const nodeModules = await realpath(path.dirname(path.dirname(target.generatedDirectory)));
  const nodeModulesRelative = path.relative(root, nodeModules);
  if (nodeModulesRelative.startsWith("..") || path.isAbsolute(nodeModulesRelative))
    throw new Error("Staged Prisma node_modules resolves outside the package stage.");
  await mkdir(path.dirname(target.generatedDirectory), { recursive: true });
  const parent = await realpath(path.dirname(target.generatedDirectory));
  const relative = path.relative(root, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Staged Prisma Client resolves outside the package stage.");
  const existing = await lstat(target.generatedDirectory).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error("Staged Prisma Client is a link outside the package stage.");
  // pnpm deploy may run @prisma/client postinstall and leave a default/stale
  // generated client. Replace that exact runtime directory after deployment.
  await rm(target.generatedDirectory, { recursive: true, force: true });
  await cp(source.generatedDirectory, target.generatedDirectory, { recursive: true,
    filter: file => !/\.tmp\d+$/.test(file) });
  const copied = await lstat(target.generatedDirectory);
  const copiedRelative = path.relative(root, await realpath(target.generatedDirectory));
  if (copied.isSymbolicLink() || copiedRelative.startsWith("..") || path.isAbsolute(copiedRelative))
    throw new Error("Copied Prisma Client escapes the package stage.");
  const staged = await validatePrismaClient(stagedDbEntry, provider);
  if (staged.schemaHash !== source.schemaHash || staged.engineHash !== source.engineHash || staged.version !== source.version)
    throw new Error("Final staged Prisma Client differs from the validated source client.");
  return staged;
}
