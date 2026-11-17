const fs = require("node:fs");
const path = require("node:path");

function requiredRuntimeAssets(resources, provider) {
  const assets = [
    path.join(resources, "api", "dist", "server.js"),
    path.join(resources, "api", "node_modules", ".prisma", "client", "query_engine-windows.dll.node"),
    path.join(resources, "web", "node_modules", "next", "dist", "bin", "next"),
    path.join(resources, "web", ".next", "BUILD_ID"),
    path.join(resources, "agent", "UpdateX.Agent.exe"),
    path.join(resources, "agent", "coreclr.dll"),
    path.join(resources, "agent", "hostfxr.dll"),
    path.join(resources, "agent", "hostpolicy.dll"),
    path.join(resources, "agent", "ReadWinGet.ps1"),
    path.join(resources, "agent", "ReadWindowsApps.ps1"),
    path.join(resources, "agent", "modules", "Microsoft.WinGet.Client", "1.29.380", "Microsoft.WinGet.Client.psd1"),
  ];
  if (provider === "sqlite") assets.push(path.join(resources, "api", "migrations", "sqlite"));
  return assets;
}

function missingRuntimeAssets(resources, provider) {
  return requiredRuntimeAssets(resources, provider).filter(file => !fs.existsSync(file));
}

function stopStartedServices(started) {
  for (const child of [...started].reverse()) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

function createStartupGate() {
  let phase = 0;
  return {
    apiReady(database, provider) {
      if (phase !== 0 || database !== provider) throw new Error("Database profile is not ready for this package.");
      phase = 1;
    },
    webReady() {
      if (phase !== 1) throw new Error("The API and database must be ready before the web service.");
      phase = 2;
    },
    agentAllowed() {
      if (phase !== 2) throw new Error("The web service must be ready before the Windows agent.");
      phase = 3;
    },
  };
}

module.exports = { requiredRuntimeAssets, missingRuntimeAssets, createStartupGate, stopStartedServices };
