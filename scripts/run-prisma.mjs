import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "../.env");
if (!existsSync(envPath)) {
  console.error("Missing .env. Copy .env.example to .env and set DATABASE_URL first.");
  process.exit(1);
}
process.loadEnvFile(envPath);
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing from .env.");
  process.exit(1);
}
const args = process.argv.slice(2);
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(command, ["--filter", "@updatepilot/db", "exec", "prisma", ...args], {
  cwd: resolve(import.meta.dirname, ".."),
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
