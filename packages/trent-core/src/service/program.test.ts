/**
 * What the unit file runs. A service must start the SAME `trent` the user installed it from, by an
 * absolute path, because launchd and systemd start it with no shell, no PATH lookup of the user's
 * choosing and `/` as the working directory: the compiled binary by its own path, the bundled CLI
 * as `node <dist/index.js>`, and a source checkout as `node <tsx loader flags> <src/index.ts>`.
 */
import { describe, expect, it } from "vitest";
import { EXIT, TrentError } from "../errors/index.js";
import { resolveServiceProgram } from "./program.js";

/** Symlinks resolved the way `fs.realpathSync` would: a fixed table, so no file is needed. */
const links: Record<string, string> = {
  "/usr/local/bin/trent": "/usr/local/lib/node_modules/trent-cli/dist/index.js",
  "/opt/homebrew/bin/trent-bin": "/opt/homebrew/Cellar/trent/1.0.0/bin/trent",
};
const realpath = (p: string): string => links[p] ?? p;

describe("resolveServiceProgram", () => {
  it("the npm-installed CLI under Node: node and the resolved dist entry, without the parent's execArgv", () => {
    const program = resolveServiceProgram(
      { execPath: "/usr/local/bin/node", argv: ["/usr/local/bin/node", "/usr/local/bin/trent", "service", "install"], execArgv: ["--max-old-space-size=4096"] },
      realpath,
    );
    expect(program).toEqual({ mode: "node-entry", argv: ["/usr/local/bin/node", "/usr/local/lib/node_modules/trent-cli/dist/index.js"] });
  });

  it("a source checkout under tsx: node, the loader flags that make a .ts entry runnable, the entry", () => {
    const execArgv = ["--require", "/repo/node_modules/tsx/dist/preflight.cjs", "--import", "file:///repo/node_modules/tsx/dist/loader.mjs", "--inspect=9229"];
    const program = resolveServiceProgram({ execPath: "/usr/bin/node", argv: ["/usr/bin/node", "/repo/apps/cli/src/index.ts"], execArgv }, realpath);
    expect(program).toEqual({
      mode: "node-entry",
      // The inspector flag is the parent's debugging session, not something a service should open.
      argv: ["/usr/bin/node", "--require", "/repo/node_modules/tsx/dist/preflight.cjs", "--import", "file:///repo/node_modules/tsx/dist/loader.mjs", "/repo/apps/cli/src/index.ts"],
    });
  });

  it("the compiled binary: its own resolved path and nothing else", () => {
    const program = resolveServiceProgram(
      { execPath: "/opt/homebrew/bin/trent-bin", argv: ["bun", "/$bunfs/root/trent", "service", "install"], execArgv: [], bunVersion: "1.3.0" },
      realpath,
    );
    expect(program).toEqual({ mode: "binary", argv: ["/opt/homebrew/Cellar/trent/1.0.0/bin/trent"] });
  });

  it("the compiled Windows binary is recognised by its B:/~BUN root", () => {
    const program = resolveServiceProgram({ execPath: "C:\\trent\\trent.exe", argv: ["bun", "B:/~BUN/root/trent.exe"], execArgv: [], bunVersion: "1.3.0" }, realpath);
    expect(program).toEqual({ mode: "binary", argv: ["C:\\trent\\trent.exe"] });
  });

  it("Bun running the source: bun and the entry", () => {
    const program = resolveServiceProgram({ execPath: "/Users/f/.bun/bin/bun", argv: ["/Users/f/.bun/bin/bun", "/repo/apps/cli/src/index.ts"], execArgv: [], bunVersion: "1.3.0" }, realpath);
    expect(program).toEqual({ mode: "bun-entry", argv: ["/Users/f/.bun/bin/bun", "/repo/apps/cli/src/index.ts"] });
  });

  it("refuses when there is no entry to run and no binary to name", () => {
    let caught: unknown;
    try {
      resolveServiceProgram({ execPath: "/usr/bin/node", argv: ["/usr/bin/node"], execArgv: [] }, realpath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TrentError);
    expect((caught as TrentError).code).toBe(EXIT.CONFIG);
  });

  it("refuses a relative entry it cannot make absolute", () => {
    expect(() => resolveServiceProgram({ execPath: "node", argv: ["node", "dist/index.js"], execArgv: [] }, (p) => p)).toThrow(TrentError);
  });
});
