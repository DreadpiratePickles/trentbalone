/**
 * [SEC-2 S2b-2] The offline proof: an OPEN row fails, an all-gated surface passes, the canary must
 * be refused, and an online run skips. The proof is dependency-injected so none of this touches the
 * process's real network or env.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { EgressBlocked } from "../../egress/offline.js";
import type { EgressPath } from "../../egress/registry.js";
import { checkOffline, proveOffline, OFFLINE_CANARY_URL } from "./offline.js";
import type { DoctorContext } from "../types.js";

const OFFLINE_ENV: NodeJS.ProcessEnv = { TRENT_OFFLINE: "1" };
const ONLINE_ENV: NodeJS.ProcessEnv = {};

/** A dial that refuses the canary exactly as the real offline trentFetch would. */
const blockingDial = async (url: string): Promise<never> => {
  throw new EgressBlocked(new URL(url).hostname, "resolves to 192.0.2.1, which is not loopback");
};
/** A dial that lets the canary through — the guard is broken. */
const openDial = async (): Promise<Response> => new Response("ok", { status: 200 });

const row = (over: Partial<EgressPath>): EgressPath => ({
  id: "r",
  module: "packages/trent-core/src/x.ts",
  dials: "trentFetch",
  defaultEnabled: true,
  offlineGate: "loopback-only",
  note: "",
  ...over,
});

const CLEAN_LOCAL_CONFIG = { provider: "ollama" };

describe("proveOffline", () => {
  it("passes when every row is gated and the canary is refused", async () => {
    const registry = [
      row({ id: "a", dials: "trentFetch", offlineGate: "loopback-only" }),
      row({ id: "b", dials: "proxy", offlineGate: "loopback-only" }),
      row({ id: "c", dials: "subprocess", offlineGate: "disabled" }),
      row({ id: "d", dials: "subprocess", offlineGate: "cached-only" }),
      row({ id: "e", dials: "socket", offlineGate: "config-rejected" }),
    ];
    const proof = await proveOffline({ config: CLEAN_LOCAL_CONFIG, env: OFFLINE_ENV, registry, dial: blockingDial });

    expect(proof.offline).toBe(true);
    expect(proof.ok).toBe(true);
    expect(proof.canary.blocked).toBe(true);
    expect(proof.canary.target).toBe(OFFLINE_CANARY_URL);
    expect(proof.rows.find((r) => r.id === "a")?.status).toBe("loopback-only");
    expect(proof.rows.find((r) => r.id === "c")?.status).toBe("blocked");
    expect(proof.rows.every((r) => r.status !== "open")).toBe(true);
    // [D5] each row is honest about HOW it is proven: a trentFetch row is dial-proven (the canary
    // fires the real shared trentFetch it falls back to); a proxy row is wiring-asserted; config /
    // tool gates carry their own method.
    expect(proof.rows.find((r) => r.id === "a")?.proof).toBe("dial-proven");
    expect(proof.rows.find((r) => r.id === "b")?.proof).toBe("wiring-asserted");
    expect(proof.rows.find((r) => r.id === "c")?.proof).toBe("tool-gate");
    expect(proof.rows.find((r) => r.id === "e")?.proof).toBe("config-rejected");
  });

  it("marks a trentFetch loopback-only row OPEN when the canary is NOT refused", async () => {
    const registry = [row({ id: "a", dials: "trentFetch", offlineGate: "loopback-only" })];
    const proof = await proveOffline({ config: CLEAN_LOCAL_CONFIG, env: OFFLINE_ENV, registry, dial: openDial });

    expect(proof.canary.blocked).toBe(false);
    expect(proof.rows[0]?.status).toBe("open");
    expect(proof.ok).toBe(false);
  });

  it("treats a row with an unrecognized gate as OPEN, so the surface cannot grow uncovered", async () => {
    const registry = [row({ id: "weird", offlineGate: "no-such-gate" as EgressPath["offlineGate"] })];
    const proof = await proveOffline({ config: CLEAN_LOCAL_CONFIG, env: OFFLINE_ENV, registry, dial: blockingDial });

    expect(proof.rows[0]?.status).toBe("open");
    expect(proof.ok).toBe(false);
  });

  it("fails and flags config-rejected rows OPEN when the loaded profile is still hosted", async () => {
    const registry = [row({ id: "esc", dials: "trentFetch", offlineGate: "config-rejected" })];
    const proof = await proveOffline({ config: { provider: "openai" }, env: OFFLINE_ENV, registry, dial: blockingDial });

    expect(proof.config.ok).toBe(false);
    expect(proof.config.violations.length).toBeGreaterThan(0);
    expect(proof.rows[0]?.status).toBe("open");
    expect(proof.ok).toBe(false);
  });

  it("[D5] force mode fires the REAL trentFetch (not a synthetic always-on dial) and restores the env", async () => {
    const before = process.env.TRENT_OFFLINE;
    // No injected dial: the default must be the real shared `trentFetch`, and force must make the
    // process offline for the duration of the canary so that real dial actually refuses 192.0.2.1.
    const proof = await proveOffline({ config: CLEAN_LOCAL_CONFIG, force: true });

    expect(proof.canary.blocked).toBe(true);
    expect(proof.canary.target).toBe(OFFLINE_CANARY_URL);
    // The process is put back exactly as it was — force does not leak offline mode.
    expect(process.env.TRENT_OFFLINE).toBe(before);
    // The real registry: trentFetch rows are dial-proven, proxy rows are wiring-asserted.
    expect(proof.rows.find((r) => r.id === "model-openai-compat")?.proof).toBe("dial-proven");
    expect(proof.rows.find((r) => r.id === "web")?.proof).toBe("wiring-asserted");
    expect(proof.rows.some((r) => r.status === "open")).toBe(false);
  });

  it("reports offline:false and an empty verdict when offline is off", async () => {
    const proof = await proveOffline({ config: CLEAN_LOCAL_CONFIG, env: ONLINE_ENV, dial: openDial });
    expect(proof.offline).toBe(false);
    expect(proof.ok).toBe(true);
    expect(proof.rows).toEqual([]);
  });
});

/** A DoctorContext whose configManager.loadConfig returns the given config, over the given env. */
function ctxWith(config: unknown, env: NodeJS.ProcessEnv): DoctorContext {
  return {
    baseDir: "/tmp/none",
    profile: "default",
    env,
    configManager: { loadConfig: () => config } as unknown as DoctorContext["configManager"],
  };
}

describe("checkOffline (DoctorCheck)", () => {
  // The check's canary uses the real `trentFetch`, which reads process.env.TRENT_OFFLINE at call
  // time — exactly as it would in a real offline run. Set it for the offline cases, clear it for the
  // online case, and always restore.
  const saved = process.env.TRENT_OFFLINE;
  beforeEach(() => {
    delete process.env.TRENT_OFFLINE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TRENT_OFFLINE;
    else process.env.TRENT_OFFLINE = saved;
  });

  it("skips when offline is off", async () => {
    const result = await checkOffline.run(ctxWith(CLEAN_LOCAL_CONFIG, ONLINE_ENV));
    expect(result.status).toBe("skip");
  });

  it("passes on a clean local offline profile (real registry, real trentFetch guard)", async () => {
    process.env.TRENT_OFFLINE = "1";
    const result = await checkOffline.run(ctxWith(CLEAN_LOCAL_CONFIG, OFFLINE_ENV));
    expect(result.status).toBe("ok");
    expect((result.details as { canaryBlocked: boolean }).canaryBlocked).toBe(true);
    expect((result.details as { open: string[] }).open).toEqual([]);
  });

  it("fails when the loaded offline profile still names a hosted provider", async () => {
    process.env.TRENT_OFFLINE = "1";
    const result = await checkOffline.run(ctxWith({ provider: "openai" }, OFFLINE_ENV));
    expect(result.status).toBe("fail");
    expect(result.fixHint).toBeTruthy();
  });
});
