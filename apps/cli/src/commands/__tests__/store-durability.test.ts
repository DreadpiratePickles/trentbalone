/**
 * P2-5a item 3: `improve status --json` said `bun:sqlite unavailable under this runtime (...)` for
 * every store failure, including under Bun when the generated Prisma client was what was missing
 * (P2-A1 measured it: docs/sessions/2026-09-25-p2a1-release-path.md). The store module is made to
 * fail to load exactly as Bun 1.4.2 fails on a clone whose client was never generated, and the
 * runtime is Bun or Node by `process.versions.bun`, the same probe the CLI uses elsewhere.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "../index.js";

vi.mock("@trent/core/store/index.js", () => {
  throw Object.assign(new Error("Cannot find module './generated/client' imported from /repo/packages/trent-core/src/store/createStore.ts"), {
    name: "ResolveMessage",
    code: "ERR_MODULE_NOT_FOUND",
  });
});

let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-store-durability-"));
  vi.stubEnv("TRENT_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Runs `fn` as if this process were Bun (or Node), restoring `process.versions.bun` after. */
async function asRuntime<T>(bun: boolean, fn: () => Promise<T>): Promise<T> {
  const saved = process.versions.bun;
  const versions = process.versions as Record<string, string | undefined>;
  if (bun) versions.bun = "1.4.2";
  else delete versions.bun;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete versions.bun;
    else versions.bun = saved;
  }
}

async function storeReason(bun: boolean): Promise<{ durable: boolean; reason?: string }> {
  const result = await asRuntime(bun, () => runCli(["improve", "status", "--json"]));
  expect(result.exitCode).toBe(EXIT.OK);
  return (JSON.parse(result.stdout) as { store: { durable: boolean; reason?: string } }).store;
}

describe("the improve store's not-durable reason", () => {
  it("under Bun with no generated client names the client and `npm run postinstall`, not Bun", async () => {
    const store = await storeReason(true);
    expect(store.durable).toBe(false);
    expect(store.reason).toMatch(/^the store's client is not generated: run `npm run postinstall`/);
    expect(store.reason).not.toMatch(/needs Bun|bun:sqlite unavailable/);
  });

  it("under Node says the store needs Bun", async () => {
    const store = await storeReason(false);
    expect(store.durable).toBe(false);
    expect(store.reason).toMatch(/^the SQLite store needs Bun/);
  });
});
