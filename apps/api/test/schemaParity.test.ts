import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function models(file: string): Map<string, string[]> {
  const source = readFileSync(file, "utf8");
  return new Map(Array.from(source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm), match => [
    match[1], match[2].split(/\r?\n/).map(line => line.trim().replace(/\s+/g, " ")).filter(Boolean),
  ]));
}

describe("provider schema parity", () => {
  it("keeps all 15 models, fields, relations, indexes, and delete actions aligned", () => {
    const root = path.resolve(process.cwd(), "../../packages/db");
    const postgres = models(path.join(root, "prisma/schema.prisma"));
    const sqlite = models(path.join(root, "prisma-sqlite/schema.prisma"));
    expect(postgres.size).toBe(15);
    expect([...sqlite.keys()]).toEqual([...postgres.keys()]);
    for (const [name, fields] of postgres) expect(sqlite.get(name)).toEqual(fields);
  });
});
