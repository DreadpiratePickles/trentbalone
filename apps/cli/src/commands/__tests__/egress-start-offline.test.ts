/**
 * [O-03] `trent egress start` offline starts the proxy with the loopback allowlist.
 *
 * `startEgressProxy` is replaced with a recorder, so no listener is bound and nothing under the real
 * `~/.trent` is written (the durable token store is lazy and never touched). The assertion is on what
 * the command hands the proxy and what it reports back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@trent/core/errors/index.js";
import { LOOPBACK_ALLOWLIST } from "@trent/core/egress/index.js";
import type { EgressHandle, StartEgressInput } from "../../repl/tools.js";

const seen: StartEgressInput[] = [];
vi.mock("../../repl/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repl/tools.js")>()),
  startEgressProxy: async (input: StartEgressInput): Promise<EgressHandle> => {
    seen.push(input);
    return { port: 18089, url: "http://127.0.0.1:18089", token: "trnt_egress_fake", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  },
}));

const { runCli } = await import("../index.js");

let home: string;
let savedOffline: string | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-egress-o03-"));
  process.env.TRENT_HOME = home;
  savedOffline = process.env.TRENT_OFFLINE;
  seen.length = 0;
});
afterEach(() => {
  delete process.env.TRENT_HOME;
  if (savedOffline === undefined) delete process.env.TRENT_OFFLINE;
  else process.env.TRENT_OFFLINE = savedOffline;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("[O-03] trent egress start", () => {
  it("offline: trent egress start hands the proxy the loopback allowlist and reports it", async () => {
    process.env.TRENT_OFFLINE = "1";
    const result = await runCli(["egress", "start", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.interceptDomains).toEqual([...LOOPBACK_ALLOWLIST]);
    expect((JSON.parse(result.stdout) as { interceptDomains: string[] }).interceptDomains).toEqual([...LOOPBACK_ALLOWLIST]);
  });

  it("online: trent egress start leaves the configured allowlist to the proxy", async () => {
    delete process.env.TRENT_OFFLINE;
    const result = await runCli(["egress", "start", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(seen[0]?.interceptDomains).toBeUndefined(); // the proxy reads config.egress.intercept_domains itself
    expect((JSON.parse(result.stdout) as { interceptDomains: string[] }).interceptDomains).not.toEqual([...LOOPBACK_ALLOWLIST]);
  });
});
