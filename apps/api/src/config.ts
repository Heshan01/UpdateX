import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: process.env.UPDATEPILOT_ENV_FILE ?? path.resolve(__dirname, "../../../.env") });

const EnvSchema = z.object({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default("http://127.0.0.1:3000"),
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
});

export const config = EnvSchema.parse(process.env);