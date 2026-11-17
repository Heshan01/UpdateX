import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stagePrismaClient, validatePrismaClient } from "../prisma-stage.mjs";

async function fixtureClient(base, provider, version = "6.19.3") {
  const packageDir = path.join(base, "node_modules", "@prisma", "client");
  const generated = path.join(base, "node_modules", ".prisma", "client");
  await mkdir(packageDir, { recursive: true });
  await mkdir(generated, { recursive: true });
  await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@prisma/client", version, main: "default.js" }));
  await writeFile(path.join(packageDir, "default.js"), "module.exports = require('.prisma/client/default');\n");
  await writeFile(path.join(generated, "default.js"), "module.exports = require('./index');\n");
  await writeFile(path.join(generated, "schema.prisma"), `datasource db {\n provider = "${provider}"\n url = env("DATABASE_URL")\n}\n`);
  await writeFile(path.join(generated, "index.js"), `const config = { "clientVersion": "${version}", "activeProvider": "${provider}" };\n`);
  await writeFile(path.join(generated, "query_engine-windows.dll.node"), Buffer.from("MZfixture"));
  return generated;
}

async function setup(provider) {
  const root = await mkdtemp(path.join(os.tmpdir(), "updatex-prisma-stage-"));
  const sourceBase = path.join(root, "packages", "db");
  const stageRoot = path.join(root, "stage");
  const stagedBase = path.join(stageRoot, "api");
  const sourceEntry = path.join(sourceBase, "dist", "index.js");
  const stagedEntry = path.join(stagedBase, "node_modules", "@updatepilot", "db", "dist", "index.js");
  await mkdir(path.dirname(sourceEntry), { recursive: true });
  await mkdir(path.dirname(stagedEntry), { recursive: true });
  await writeFile(sourceEntry, "module.exports = require('@prisma/client');\n");
  await writeFile(stagedEntry, "module.exports = require('@prisma/client');\n");
  const sourceGenerated = await fixtureClient(sourceBase, provider);
  const stagedGenerated = await fixtureClient(stagedBase, "postgresql");
  return { root, sourceEntry, stagedEntry, stageRoot, sourceGenerated, stagedGenerated };
}

test("SQLite stage selects the db package's client and replaces a deploy postinstall client", async () => {
  const fx = await setup("sqlite");
  try {
    // An unrelated repository-root client is PostgreSQL, as in the reported failure.
    await fixtureClient(fx.root, "postgresql");
    const result = await stagePrismaClient(fx.sourceEntry, fx.stagedEntry, "sqlite", fx.stageRoot);
    assert.equal(result.provider, "sqlite");
    assert.match(await readFile(path.join(fx.stagedGenerated, "schema.prisma"), "utf8"), /provider = "sqlite"/);
    assert.equal((await validatePrismaClient(fx.stagedEntry, "sqlite")).engineHash, result.engineHash);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("PostgreSQL profile stages a matching PostgreSQL client", async () => {
  const fx = await setup("postgresql");
  try {
    const result = await stagePrismaClient(fx.sourceEntry, fx.stagedEntry, "postgresql", fx.stageRoot);
    assert.equal(result.provider, "postgresql");
    assert.match(await readFile(path.join(fx.stagedGenerated, "schema.prisma"), "utf8"), /provider = "postgresql"/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("staging succeeds when deploy did not generate a client", async () => {
  const fx = await setup("sqlite");
  try {
    await rm(path.dirname(fx.stagedGenerated), { recursive: true, force: true });
    await stagePrismaClient(fx.sourceEntry, fx.stagedEntry, "sqlite", fx.stageRoot);
    assert.equal((await validatePrismaClient(fx.stagedEntry, "sqlite")).provider, "sqlite");
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("provider mismatch is rejected before replacing staged output", async () => {
  const fx = await setup("postgresql");
  try {
    await assert.rejects(stagePrismaClient(fx.sourceEntry, fx.stagedEntry, "sqlite", fx.stageRoot), /provider mismatch/);
    assert.match(await readFile(path.join(fx.stagedGenerated, "schema.prisma"), "utf8"), /provider = "postgresql"/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});

test("missing or invalid Windows query engine is rejected", async () => {
  const fx = await setup("sqlite");
  try {
    await writeFile(path.join(fx.sourceGenerated, "query_engine-windows.dll.node"), "not a DLL");
    await assert.rejects(stagePrismaClient(fx.sourceEntry, fx.stagedEntry, "sqlite", fx.stageRoot), /engine is missing or invalid/);
  } finally { await rm(fx.root, { recursive: true, force: true }); }
});
