import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

describe("Workbench provider registry imports", () => {
  it("keeps API routes that resolve providers wired to the full registry", () => {
    const routeFiles = listFiles(path.join(process.cwd(), "app/api/workbench"))
      .filter((file) => file.endsWith("route.ts"));
    const offenders = routeFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes("getWorkbenchProvider(")
        && !source.includes('import "@/lib/workbench-providers"');
    });

    expect(offenders.map((file) => path.relative(process.cwd(), file))).toEqual([]);
  });
});

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}
