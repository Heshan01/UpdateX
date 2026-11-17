import { db, initializeSqliteDatabase, prepareDatabase, sqliteFileUrl, SqliteStartupError } from "@updatepilot/db";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config";
import { createApp } from "./app";

async function start() {
  const sqlite = process.env.UPDATE_X_DB_PROVIDER === "sqlite";
  const databasePath = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "UpdateX", "data", "updatex.db");
  if (sqlite && process.env.DATABASE_URL !== sqliteFileUrl(databasePath))
    throw new SqliteStartupError("SQLITE_SCHEMA_INCOMPATIBLE");
  const initialized = sqlite ? await initializeSqliteDatabase(db, {
    databasePath,
    migrationsDirectory: process.env.UPDATE_X_SQLITE_MIGRATIONS_DIR ??
      path.resolve(__dirname, "../../../packages/db/prisma-sqlite/migrations"),
  }) : null;
  if (!sqlite) await prepareDatabase(db);
  const server = createApp(db).listen(config.API_PORT, config.API_HOST, () => {
    console.log(`UpdateX API listening on http://${config.API_HOST}:${config.API_PORT}`);
  });
  server.on("error", error => {
    const code = "code" in error && error.code === "EADDRINUSE" ? "LOCAL_PORT_IN_USE" : "SERVICE_START_FAILED";
    console.error(JSON.stringify({ component: "updatex-api", event: "startup_failed", code }));
    const statusFile = process.env.UPDATE_X_STARTUP_STATUS_FILE;
    if (statusFile) void writeFile(statusFile, JSON.stringify({ code }), { mode: 0o600 }).catch(() => undefined);
    void db.$disconnect().finally(async () => {
      await initialized?.release();
      process.exitCode = 1;
    });
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => { void db.$disconnect().finally(async () => {
        await initialized?.release();
        process.exit(0);
      }); });
    });
  }
}

void start().catch(async error => {
  const code = error instanceof SqliteStartupError ? error.code : "DATABASE_STARTUP_FAILED";
  console.error(JSON.stringify({ component: "updatex-api", event: "startup_failed", code }));
  const statusFile = process.env.UPDATE_X_STARTUP_STATUS_FILE;
  if (statusFile) await writeFile(statusFile, JSON.stringify({ code }), { mode: 0o600 }).catch(() => undefined);
  await db.$disconnect();
  process.exitCode = 1;
});
