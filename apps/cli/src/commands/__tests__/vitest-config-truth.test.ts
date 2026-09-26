/**
 * Pins the root vitest.config.ts "exclusive" project to what vitest 3.2.7 actually does.
 *
 * `fileParallelism` is a NonProjectOptions key (vitest/dist/chunks/reporters.d.BuRON0I0.d.ts:2347),
 * so a project that sets it is silently ignored. The only per-project serial knob the shared forks
 * pool reads is `poolOptions.forks.singleFork` (typed at :2355, read at coverage.DfSpMS-b.js:2674).
 * Only desktop.test.ts (hdiutil mounts, serial on macOS) has a standing reason to run alone; the
 * derive-sqlite-schema writer no longer touches the shared client (723ef22), and that writer, not a
 * Bun transpile-cache race, was what killed the Bun-child suites, so all five belong in "parallel".
 */
import { describe, expect, it } from "vitest";
import config from "../../../../../vitest.config";

const DESKTOP = "apps/cli/src/commands/__tests__/desktop.test.ts";

const MOVED_BACK_TO_PARALLEL = [
  "packages/trent-core/src/store/derive-sqlite-schema.test.ts",
  "apps/cli/src/repl/__tests__/approvals.restart.test.ts",
  "apps/cli/src/commands/__tests__/audit.test.ts",
  "packages/trent-core/src/store/store.durability.test.ts",
  "packages/trent-core/src/fleet-memory/app-memory.bun.test.ts",
];

interface InlineProject {
  extends?: unknown;
  test?: {
    name?: string;
    include?: string[];
    exclude?: string[];
    pool?: string;
    fileParallelism?: boolean;
    poolOptions?: { forks?: { singleFork?: boolean } };
  };
}

function project(name: string): InlineProject {
  const projects = (config.test?.projects ?? []) as unknown[];
  const found = projects.find(
    (p): p is InlineProject =>
      typeof p === "object" && p !== null && (p as InlineProject).test?.name === name,
  );
  if (!found) throw new Error(`vitest.config.ts has no inline project named "${name}"`);
  return found;
}

describe("vitest.config.ts: the exclusive project is truthful and really serial", () => {
  it("collects exactly desktop.test.ts, nothing else", () => {
    expect(project("exclusive").test?.include).toEqual([DESKTOP]);
  });

  it("uses the per-project knob the forks pool honours (singleFork), not the ignored fileParallelism", () => {
    const test = project("exclusive").test;
    expect(test?.pool ?? "forks").toBe("forks");
    expect(test?.poolOptions?.forks?.singleFork).toBe(true);
    expect(test).not.toHaveProperty("fileParallelism");
  });

  it("returns derive-sqlite-schema and the four Bun-child suites to the parallel project", () => {
    const exclude = project("parallel").test?.exclude ?? [];
    expect(MOVED_BACK_TO_PARALLEL.filter((file) => exclude.includes(file))).toEqual([]);
  });

  it("still keeps desktop.test.ts out of the parallel project, so it runs once, alone", () => {
    expect(project("parallel").test?.exclude ?? []).toContain(DESKTOP);
  });
});
