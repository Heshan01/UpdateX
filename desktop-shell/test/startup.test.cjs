const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { createStartupGate, missingRuntimeAssets, requiredRuntimeAssets, stopStartedServices } = require("../startup-policy.cjs");

test("packaged SQLite runtime requires web, API, Prisma engine, migrations, and self-contained agent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "updatex-assets-"));
  try {
    const files = requiredRuntimeAssets(root, "sqlite");
    assert.ok(files.some(file => file.endsWith("query_engine-windows.dll.node")));
    assert.ok(files.some(file => file.endsWith(path.join("migrations", "sqlite"))));
    assert.ok(files.some(file => file.endsWith("coreclr.dll")));
    assert.equal(missingRuntimeAssets(root, "sqlite").length, files.length);
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (file.endsWith(path.join("migrations", "sqlite"))) fs.mkdirSync(file, { recursive: true });
      else fs.writeFileSync(file, "placeholder");
    }
    assert.deepEqual(missingRuntimeAssets(root, "sqlite"), []);
    fs.rmSync(files[1]);
    assert.deepEqual(missingRuntimeAssets(root, "sqlite"), [files[1]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("PostgreSQL package does not require SQLite migrations", () => {
  assert.ok(!requiredRuntimeAssets("C:\\stage", "postgresql").some(file => file.endsWith(path.join("migrations", "sqlite"))));
});

test("startup gate rejects agent before API/database and web readiness", () => {
  const gate = createStartupGate();
  assert.throws(() => gate.agentAllowed());
  assert.throws(() => gate.webReady());
  assert.throws(() => gate.apiReady("postgresql", "sqlite"));
  gate.apiReady("sqlite", "sqlite");
  assert.throws(() => gate.agentAllowed());
  gate.webReady();
  gate.agentAllowed();
  assert.throws(() => gate.agentAllowed());
});

test("partial startup failure stops only services owned by this launch", () => {
  const stopped = [];
  const api = { exitCode: null, signalCode: null, kill: () => stopped.push("api") };
  const web = { exitCode: null, signalCode: null, kill: () => stopped.push("web") };
  const unrelated = { exitCode: null, signalCode: null, kill: () => stopped.push("unrelated") };
  stopStartedServices([api, web]);
  assert.deepEqual(stopped, ["web", "api"]);
  assert.equal(unrelated.exitCode, null);
});

test("an occupied loopback port rejects a second listener without touching its owner", async () => {
  const first = net.createServer();
  await new Promise(resolve => first.listen(0, "127.0.0.1", resolve));
  const port = first.address().port;
  const second = net.createServer();
  try {
    const result = await new Promise(resolve => {
      second.once("error", error => resolve(error.code));
      second.listen(port, "127.0.0.1", () => resolve("unexpectedly-open"));
    });
    assert.equal(result, "EADDRINUSE");
    assert.equal(first.listening, true);
  } finally {
    if (second.listening) second.close();
    await new Promise(resolve => first.close(resolve));
  }
});

test("NSIS remains per-user and keeps application data outside installer resources", () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "electron-builder.json"), "utf8"));
  assert.equal(config.nsis.perMachine, false);
  assert.ok(config.files.includes("startup-policy.cjs"));
  assert.ok(config.extraResources.some(entry => entry.to === "services"));
  assert.ok(!config.extraResources.some(entry => /\.env|updatex\.db|license-activation\.bin/i.test(entry.from)));
});
