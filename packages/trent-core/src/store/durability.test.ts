/**
 * Why the durable store did not open, in words that name the real cause. The "not durable" lines
 * blamed Bun on every failure, including under Bun when the generated Prisma client was what was
 * missing (P2-A1, docs/sessions/2026-09-25-p2a1-release-path.md: `bun ... improve status --json`
 * said "bun:sqlite unavailable under this runtime (Cannot find module './generated/client' ...)").
 *
 * The error shapes below are the ones the runtimes really produce, captured on this machine:
 * Node importing `bun:sqlite`, and Bun 1.4.2 importing a module whose `./generated/client` is absent.
 */
import { describe, expect, it, vi } from "vitest";
import { diagnoseStoreFailure, explainStoreFailure } from "./durability.js";

const nodeError = Object.assign(new Error("Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'bun:'"), {
  code: "ERR_UNSUPPORTED_ESM_URL_SCHEME",
});
const missingClient = Object.assign(new Error("Cannot find module './generated/client' imported from /repo/packages/trent-core/src/store/createStore.ts"), {
  name: "ResolveMessage",
  code: "ERR_MODULE_NOT_FOUND",
});

describe("explainStoreFailure", () => {
  it("under Node says the store needs Bun and how to run under it", () => {
    const failure = explainStoreFailure(nodeError, false);
    expect(failure.cause).toBe("needs_bun");
    expect(failure.reason).toMatch(/^the SQLite store needs Bun/);
    expect(failure.reason).toContain("npm run cli:bun");
  });

  it("under Bun with the generated client missing names the client and `npm run postinstall`, never Bun", () => {
    const failure = explainStoreFailure(missingClient, true);
    expect(failure.cause).toBe("client_not_generated");
    expect(failure.reason).toMatch(/^the store's client is not generated: run `npm run postinstall`/);
    expect(failure.reason).not.toMatch(/needs Bun|bun:sqlite unavailable/);
  });

  it("finds the missing client through a wrapping error's cause", () => {
    const wrapped = new Error("[loader] failed to load @trent/core/store/index.js", { cause: missingClient });
    expect(explainStoreFailure(wrapped, true).cause).toBe("client_not_generated");
  });

  it("under Bun with any other failure says the store did not open and gives the first line of why", () => {
    const failure = explainStoreFailure(new Error("SQLITE_CANTOPEN: unable to open database file\n    at connect"), true);
    expect(failure.cause).toBe("open_failed");
    expect(failure.reason).toBe("the SQLite store did not open: SQLITE_CANTOPEN: unable to open database file");
  });
});

describe("diagnoseStoreFailure, for a surface that only knows the store is not durable", () => {
  it("under Node answers needs Bun without loading anything", async () => {
    const load = vi.fn(async () => ({}));
    expect((await diagnoseStoreFailure({ bun: false, load })).cause).toBe("needs_bun");
    expect(load).not.toHaveBeenCalled();
  });

  it("under Bun loads the store module and names the missing client when that is what fails", async () => {
    const failure = await diagnoseStoreFailure({ bun: true, load: async () => Promise.reject(missingClient) });
    expect(failure.cause).toBe("client_not_generated");
  });

  it("under Bun, when the module loads, says the store did not open rather than guessing", async () => {
    expect((await diagnoseStoreFailure({ bun: true, load: async () => ({}) })).cause).toBe("open_failed");
  });
});
