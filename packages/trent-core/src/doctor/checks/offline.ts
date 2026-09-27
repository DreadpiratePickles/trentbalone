/**
 * [SEC-2 S2b-2] The offline-mode proof.
 *
 * Walks the enumerated egress surface ({@link EGRESS_PATHS}) and, when `TRENT_OFFLINE` is on, certifies
 * that every path is covered by one of the three offline layers — `trentFetch`/proxy loopback-only,
 * config rejection, or a disabled/cached-only tool gate. Each row is printed `blocked` /
 * `loopback-only` / `OPEN` with the layer that covers it, and the check FAILS if any row is `OPEN`.
 *
 * It does not just read the registry — it actively proves the live guard two ways:
 *   1. A canary dial to the RFC 5737 TEST-NET-1 literal `192.0.2.1` (a literal, so no DNS) fired
 *      through the REAL shared {@link trentFetch} — the exact dial every trentFetch row falls back
 *      to, NOT a freshly-constructed always-on guard — must throw {@link EgressBlocked}. If it does
 *      not, every trentFetch loopback-only row is reported OPEN, because the guard is not holding.
 *   2. `assertOfflineConfig` on the loaded profile must pass — no hosted provider, escalation,
 *      embedder, remote OTLP endpoint or enabled gateway/social route survived config load.
 *
 * [D5] De-circularised proof. The old canary fired a synthetic `createForcedOfflineDial()`, which
 * proved only the PREDICATE (`assertLocalTarget` refuses a public IP), not that the modules are
 * wired through the guard. Now each row is honest about HOW it is proven:
 *   - `dial-proven`   the canary fires the REAL shared `trentFetch` these rows fall back to; a refusal
 *                     exercises the actual dial, and the coverage test (`egress/registry.test.ts`)
 *                     statically confirms each such module routes through `trentFetch` (identity).
 *   - `wiring-asserted` proxy rows (routed through the egress proxy, whose allowlist collapses to the
 *                     loopback set offline) and loopback-base rows (`node:https` pinned to 127.0.0.1):
 *                     the canary cannot drive them here without side effects, so they are asserted
 *                     structurally by the coverage test rather than dialed.
 *   - `config-rejected` / `tool-gate`  proven by `assertOfflineConfig` / a disabled or cached gate.
 *
 * Honest caveat, surfaced in the output: this proves the trentFetch + proxy paths, the config-gated
 * paths and the disabled/cached tools. It is Trent's own code, not a kernel firewall — a raw syscall
 * from a subprocess Trent did not spawn is out of its reach.
 *
 * When offline is OFF the check is informational and reports `skip`; it never fails an online run.
 */
import { EgressBlocked, isOffline } from "../../egress/offline.js";
import { assertOfflineConfig, offlineConfigViolations } from "../../egress/offline-config.js";
import { EGRESS_PATHS, type EgressPath } from "../../egress/registry.js";
import { trentFetch } from "../../egress/dial.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

const CATEGORY = "Offline";
const NAME = "Offline egress proof";
/** RFC 5737 TEST-NET-1: a public literal, reached by no DNS, so a refusal proves the address rule. */
export const OFFLINE_CANARY_URL = "http://192.0.2.1/";
export const OFFLINE_CAVEAT =
  "This proves the trentFetch + proxy paths, the config-gated settings and the disabled/cached tools. " +
  "It is Trent's own code, not a kernel firewall: a raw socket from a subprocess Trent did not spawn is out of reach.";

export type OfflineRowStatus = "blocked" | "loopback-only" | "open";

/**
 * [D5] How a row is proven, so the output never claims more than it did. `dial-proven` rows are
 * exercised by the live canary through the real shared trentFetch; `wiring-asserted` rows are
 * covered structurally (verified by the coverage test), not dialed here.
 */
export type ProofMethod = "dial-proven" | "wiring-asserted" | "config-rejected" | "tool-gate";

export interface OfflineProofRow {
  readonly id: string;
  readonly module: string;
  readonly dials: EgressPath["dials"];
  readonly defaultEnabled: boolean;
  readonly gate: EgressPath["offlineGate"];
  readonly status: OfflineRowStatus;
  /** How this row is proven — see {@link ProofMethod}. */
  readonly proof: ProofMethod;
  /** Which layer covers this row (or why it is open). */
  readonly layer: string;
}

/**
 * The proof method a row gets, derived purely from its gate and dial — no source read, so it holds
 * in the shipped (Bun-compiled) binary too. The coverage test keeps this derivation honest by
 * statically asserting each loopback-only module actually routes through the transport it claims.
 */
export function proofMethodFor(path: EgressPath): ProofMethod {
  switch (path.offlineGate) {
    case "config-rejected":
      return "config-rejected";
    case "disabled":
    case "cached-only":
      return "tool-gate";
    case "loopback-only":
      // trentFetch rows fall back to the shared trentFetch the canary actually fires → dial-proven.
      // proxy / loopback-base rows are covered structurally → wiring-asserted.
      return path.dials === "trentFetch" ? "dial-proven" : "wiring-asserted";
    default:
      return "wiring-asserted";
  }
}

export interface OfflineProof {
  readonly offline: boolean;
  /** True when offline is on and no row is OPEN and both active proofs held. */
  readonly ok: boolean;
  readonly canary: { readonly target: string; readonly blocked: boolean; readonly detail: string };
  readonly config: { readonly ok: boolean; readonly violations: string[] };
  readonly rows: readonly OfflineProofRow[];
  readonly caveat: string;
}

export interface ProveOfflineDeps {
  /** The loaded profile config, inspected by `assertOfflineConfig`. */
  readonly config: unknown;
  /** Defaults to `process.env`; decides whether offline is on and feeds the config check. */
  readonly env?: NodeJS.ProcessEnv;
  /** The registry to walk; defaults to the shipped {@link EGRESS_PATHS}. Injected in tests. */
  readonly registry?: readonly EgressPath[];
  /** The dial used for the canary; defaults to the real shared {@link trentFetch}. Injected in tests. */
  readonly dial?: (url: string) => Promise<unknown>;
  /**
   * Force the proof to evaluate as if offline is on, even on a process that is not — used by
   * `trent security --offline` so the operator can certify coverage without relaunching. `TRENT_OFFLINE`
   * is set on the process for the duration of the canary (then restored) so the REAL `trentFetch`
   * engages its guard: the canary exercises the actual dial, not a synthetic always-on one.
   */
  readonly force?: boolean;
}

/**
 * Put the process into offline mode for the duration of one canary and hand back an idempotent
 * restore. Used only in `force` mode so the REAL `trentFetch` (which reads `TRENT_OFFLINE` at call
 * time) actually refuses; a one-shot proof command runs nothing else concurrently.
 */
function withForcedOffline(): () => void {
  const saved = process.env.TRENT_OFFLINE;
  process.env.TRENT_OFFLINE = "1";
  return () => {
    if (saved === undefined) delete process.env.TRENT_OFFLINE;
    else process.env.TRENT_OFFLINE = saved;
  };
}

/** Fire the canary dial and report whether the offline guard refused it. */
async function fireCanary(dial: (url: string) => Promise<unknown>, forced: boolean): Promise<OfflineProof["canary"]> {
  const restore = forced ? withForcedOffline() : undefined;
  try {
    await dial(OFFLINE_CANARY_URL);
    return { target: OFFLINE_CANARY_URL, blocked: false, detail: "the dial was NOT refused — the offline guard is not holding" };
  } catch (err) {
    if (err instanceof EgressBlocked) return { target: OFFLINE_CANARY_URL, blocked: true, detail: err.message };
    // Any other throw (a real connection error) also means no bytes reached a public host, but it is
    // not the guard we are proving, so we do not count it as blocked-by-guard.
    return { target: OFFLINE_CANARY_URL, blocked: false, detail: `dial threw a non-guard error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    restore?.();
  }
}

/** Classify one registry row given the two active-proof results. */
function classify(path: EgressPath, canaryBlocked: boolean, configOk: boolean): OfflineProofRow {
  const proof = proofMethodFor(path);
  const base = { id: path.id, module: path.module, dials: path.dials, defaultEnabled: path.defaultEnabled, gate: path.offlineGate, proof };
  switch (path.offlineGate) {
    case "disabled":
      return { ...base, status: "blocked", layer: "tool gate — disabled offline" };
    case "cached-only":
      return { ...base, status: "blocked", layer: "tool gate — local cached model only" };
    case "config-rejected":
      return configOk
        ? { ...base, status: "blocked", layer: "config loader — the enabling setting is refused at load" }
        : { ...base, status: "open", layer: "config loader — a hosted setting survived load; assertOfflineConfig failed" };
    case "loopback-only":
      if (path.dials === "trentFetch") {
        return canaryBlocked
          ? { ...base, status: "loopback-only", layer: "trentFetch — dial-proven: the 192.0.2.1 canary fired the real shared trentFetch and was refused" }
          : { ...base, status: "open", layer: "trentFetch — the canary was NOT refused; the guard is not holding" };
      }
      if (path.dials === "proxy") return { ...base, status: "loopback-only", layer: "egress proxy — wiring-asserted: allowlist collapsed to the loopback set (coverage test confirms the route)" };
      return { ...base, status: "loopback-only", layer: "wiring-asserted: targets the configured loopback base only (coverage test confirms the route)" };
    default:
      return { ...base, status: "open", layer: `unknown gate "${String(path.offlineGate)}"` };
  }
}

/**
 * The proof itself, dependency-injected so a test can force an OPEN row, a passing canary, or a
 * hosted config. Reads offline state from `env` (via {@link isOffline}); returns `offline:false` and
 * an empty verdict when offline is off.
 */
export async function proveOffline(deps: ProveOfflineDeps): Promise<OfflineProof> {
  const forced = deps.force === true;
  // In force mode, offline is treated as on for both the config check and the isOffline gate.
  const env = forced ? { ...(deps.env ?? process.env), TRENT_OFFLINE: "1" } : deps.env ?? process.env;
  const registry = deps.registry ?? EGRESS_PATHS;
  // Always the REAL shared trentFetch (the exact dial every trentFetch row falls back to); `force`
  // makes the process offline around the canary so that real dial engages, rather than swapping in a
  // synthetic always-on guard that would prove only the predicate.
  const dial = deps.dial ?? trentFetch;

  if (!isOffline(env)) {
    return {
      offline: false,
      ok: true,
      canary: { target: OFFLINE_CANARY_URL, blocked: false, detail: "offline mode is off; the guard is not engaged" },
      config: { ok: true, violations: [] },
      rows: [],
      caveat: OFFLINE_CAVEAT,
    };
  }

  const canary = await fireCanary(dial, forced);
  const violations = offlineConfigViolations(deps.config, env).map((v) => `${v.setting}: ${v.detail}`);
  let configOk = true;
  try {
    assertOfflineConfig(deps.config, env);
  } catch {
    configOk = false;
  }

  const rows = registry.map((path) => classify(path, canary.blocked, configOk));
  const ok = canary.blocked && configOk && rows.every((r) => r.status !== "open");
  return { offline: true, ok, canary, config: { ok: configOk, violations }, rows, caveat: OFFLINE_CAVEAT };
}

/** A one-line count of the row statuses (and how they were proven), for the check message. */
export function summarizeProof(proof: OfflineProof): string {
  const open = proof.rows.filter((r) => r.status === "open").length;
  const loopback = proof.rows.filter((r) => r.status === "loopback-only").length;
  const blocked = proof.rows.filter((r) => r.status === "blocked").length;
  const dialProven = proof.rows.filter((r) => r.proof === "dial-proven").length;
  const wiringAsserted = proof.rows.filter((r) => r.proof === "wiring-asserted").length;
  return `${proof.rows.length} egress paths: ${blocked} blocked, ${loopback} loopback-only, ${open} OPEN (${dialProven} dial-proven, ${wiringAsserted} wiring-asserted)`;
}

export const checkOffline: DoctorCheck = {
  id: "check_offline",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const env = ctx.env ?? process.env;
    if (!isOffline(env)) {
      return {
        category: CATEGORY,
        name: NAME,
        status: "skip",
        message: "Offline mode is off (TRENT_OFFLINE not set); the egress guard is not engaged, so nothing to prove.",
        details: { offline: false },
      };
    }
    let config: unknown = {};
    try {
      config = ctx.configManager.loadConfig();
    } catch {
      /* a profile that will not load is a different check's finding; prove the guard against {} */
    }
    const proof = await proveOffline({ config, env });
    const open = proof.rows.filter((r) => r.status === "open");
    const details = {
      offline: true,
      canaryBlocked: proof.canary.blocked,
      configOk: proof.config.ok,
      open: open.map((r) => r.id),
      rows: proof.rows.map((r) => ({ id: r.id, status: r.status, proof: r.proof, layer: r.layer })),
      caveat: proof.caveat,
    };
    if (!proof.ok) {
      const why = !proof.canary.blocked
        ? `the 192.0.2.1 canary was not refused (${proof.canary.detail})`
        : !proof.config.ok
          ? `the loaded profile still names hosted settings (${proof.config.violations.join("; ")})`
          : `${open.length} egress path(s) are OPEN: ${open.map((r) => r.id).join(", ")}`;
      return {
        category: CATEGORY,
        name: NAME,
        status: "fail",
        message: `Offline mode is on but the egress surface is not fully covered — ${why}.`,
        fixHint: "Close the OPEN path(s): route the dial through trentFetch/the proxy, reject the setting at config load, or disable the tool offline.",
        details,
      };
    }
    return {
      category: CATEGORY,
      name: NAME,
      status: "ok",
      message: `Offline mode is on and every egress path is covered — ${summarizeProof(proof)}. ${proof.caveat}`,
      details,
    };
  },
};
