import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildId = path.join(webDir, ".next", "BUILD_ID");
if (!existsSync(buildId)) {
  console.error("Build the web app with `pnpm build` before running Playwright.");
  process.exit(1);
}

// This process never starts the API. A guard on this separate port rejects any
// request that escapes the browser's in-memory API fixtures.
process.env.API_PORT = "49999";
process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(webDir, "../../.local/playwright-browsers");
process.env.NEXT_TELEMETRY_DISABLED = "1";

const app = next({ dev: false, dir: webDir, hostname: "127.0.0.1", port: 3100 });
let server;
let apiGuard;
let unmockedApiRequests = 0;
let exitCode = 1;
try {
  apiGuard = http.createServer((_request, response) => {
    unmockedApiRequests += 1;
    response.writeHead(503).end("The browser test API must be mocked.");
  });
  await new Promise((resolve, reject) => {
    apiGuard.once("error", reject);
    apiGuard.listen(49999, "127.0.0.1", resolve);
  });
  await app.prepare();
  server = http.createServer((request, response) => {
    void app.getRequestHandler()(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(3100, "127.0.0.1", resolve);
  });

  const cli = path.join(webDir, "node_modules", "@playwright", "test", "cli.js");
  const runner = spawn(process.execPath, [cli, "test", ...process.argv.slice(2)], {
    cwd: webDir, env: process.env, stdio: "inherit",
  });
  exitCode = await new Promise(resolve => {
    runner.once("error", error => { console.error(error); resolve(1); });
    runner.once("exit", code => resolve(code ?? 1));
  });
  if (unmockedApiRequests) {
    console.error(`${unmockedApiRequests} API request(s) escaped the isolated browser fixtures.`);
    exitCode = 1;
  }
} catch (error) {
  console.error(error);
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (apiGuard) {
    apiGuard.closeAllConnections();
    await new Promise(resolve => apiGuard.close(resolve));
  }
  await app.close();
}
process.exit(exitCode);
