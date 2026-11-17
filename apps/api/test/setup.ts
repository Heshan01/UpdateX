import type { NextFunction, Request, Response } from "express";
import { vi } from "vitest";

// Existing API tests isolate account, agent and job behavior. Production uses
// the real offline certificate gate; this stub exists only inside Vitest.
vi.mock("../src/licenseGate", () => ({
  packagedLicenseGate: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
