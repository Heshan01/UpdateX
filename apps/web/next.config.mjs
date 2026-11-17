import path from "node:path";
import { existsSync } from "node:fs";

const rootEnv = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig = {
  devIndicators: false,
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `http://127.0.0.1:${process.env.API_PORT ?? "4000"}/api/v1/:path*` }];
  },
};

export default nextConfig;
