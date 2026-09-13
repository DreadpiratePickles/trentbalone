import { describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expectedStoreContract, runStoreContract, type StoreContractResult } from "./store-contract.js";
import { InMemoryImproveStore } from "./memory-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function findBun(): string {
  const fromEnv = process.env.TRENT_BUN_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const onPath = execSync("command -v bun", { encoding: "utf8" }).trim();
    if (onPath !== "") return onPath;
  } catch {
    /* fall through */
  }
  const standard = path.join(homedir(), ".bun", "bin", "bun");
  if (existsSync(standard)) return standard;
  throw new Error("bun not found; the SQLite improve store is bun:sqlite and cannot be exercised without it");
}

describe("improve store contract — in-memory (Node)", () => {
  it("satisfies the contract", async () => {
    const result = await runStoreContract(new InMemoryImproveStore());
    expect(result).toEqual(expectedStoreContract());
  });
});

describe("improve store contract — real SQLite through PrismaStore (Bun)", () => {
  it("satisfies the same contract on the six durable tables, and survives a reopen", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "trent-improve-")), "trent.db");
    const stdout = execFileSync(findBun(), [path.join(here, "sqlite-scenario.ts"), file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(stdout) as { first: StoreContractResult; reopened: { traces: number; drafts: number; ledger: number; gateCache: number } };
    expect(parsed.first).toEqual(expectedStoreContract());
    expect(parsed.reopened).toEqual({ traces: 4, drafts: 2, ledger: 1, gateCache: 1 });
  });
});
