/**
 * [SEC-2 S2b-1] The coverage guarantee: the enumerated egress surface cannot silently grow.
 *
 * This walks every non-test source file under packages/trent-core/src, flags each one that imports or
 * uses a network primitive, and asserts every flagged module is either a registered {@link EGRESS_PATHS}
 * row or on the curated {@link KNOWN_NON_EGRESS} allowlist of paths that are inbound listeners or proxy
 * internals, not egress. A new hosted-egress module that is registered in neither list fails this test
 * — so adding egress without enumerating it breaks CI.
 *
 * [D6] The scan used to only see modules that IMPORT a fetch primitive, so a module reaching the
 * network another way was invisible and could bypass `trentFetch` while never appearing in the
 * registry. The scan now also flags:
 *   - a call to the GLOBAL `fetch(` that is not `trentFetch`/`createTrentFetch`/`createEgressFetch`
 *     (a bare global fetch imports nothing and matched no old signal);
 *   - imports of `node:net` / `node:dgram` / `node:tls` / `node:https` / `node:http`;
 *   - an obvious network subprocess spawn (a `spawn`/`exec…` of `curl`/`wget`/`nc`/`ssh`/… by literal).
 * Comments and strings are stripped before the bare-`fetch`/spawn scan so prose ("a network fetch")
 * and error text do not trip it.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EGRESS_PATHS, NETWORK_CAPABLE_MODULES, egressPathsByGate, type EgressPath } from "./registry.js";
import { proofMethodFor } from "../doctor/checks/offline.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SRC_DIR, "../../..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** A network primitive matched on the RAW file text (imports and `new`/member forms). */
const NETWORK_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ["trentFetch", /\btrentFetch\b/],
  ["createEgressFetch", /\bcreateEgressFetch\b/],
  ["node:https", /from\s+["']node:https["']/],
  ["node:http", /from\s+["']node:http["']/],
  ["node:net", /from\s+["']node:net["']/],
  ["node:dgram", /from\s+["']node:dgram["']/],
  ["node:tls", /from\s+["']node:tls["']/],
  ["WebSocket", /new\s+WebSocket\s*\(/],
  ["ws-module", /from\s+["']ws["']/],
  ["net.connect", /\bnet\.connect\s*\(/],
  ["tls.connect", /\btls\.connect\s*\(/],
  ["createConnection", /\bcreateConnection\s*\(/],
  ["net.Socket", /new\s+net\.Socket\b/],
];

/** Network binaries whose spawn is unambiguously egress. */
const NETWORK_BINARY = /\b(?:curl|wget|nc|ncat|socat|ssh|scp|sftp|rsync|telnet|ftp)\b/;

/** Strip block and line comments so prose and error strings do not trip the code-shape scans. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * A call to the GLOBAL `fetch(`, excluding the guarded wrappers (`trentFetch`, `createTrentFetch`,
 * `createEgressFetch` — whose `fetch` substring carries a capital F, so lowercase `fetch(` never
 * matches them) and method definitions / member calls (`.fetch(`, `async fetch(`).
 */
function usesBareGlobalFetch(code: string): boolean {
  const re = /(?<![\w$.])fetch\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const before = code.slice(Math.max(0, m.index - 30), m.index);
    // A method/function DEFINITION named fetch, not a call to the global.
    if (/(?:\basync\s+|\bfunction\s+|\b(?:public|private|protected|static|readonly|get|set)\s+)$/.test(before)) continue;
    return true;
  }
  return false;
}

/** An `exec`/`spawn`-family call whose first (literal) argument is a network binary. */
function usesNetworkSpawn(code: string): boolean {
  const re = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(\s*(["'`])([^"'`]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (NETWORK_BINARY.test(m[2] ?? "")) return true;
  }
  return false;
}

/**
 * A file is out of scope for the scan when it is test-only (never shipped), or when it is the
 * registry itself — which names the primitives in prose, not as dials.
 */
function isTestOnly(file: string): boolean {
  return (
    /\.test\.[cm]?tsx?$/.test(file) ||
    file.includes("/__tests__/") ||
    file.includes("/__fixtures__/") ||
    file.includes("/fixtures/") ||
    file.includes("/testing/") ||
    file.includes("test-helper") ||
    file.endsWith("egress/registry.ts")
  );
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

/**
 * Curated false positives: modules the scan flags that are NOT hosted egress. Each is an inbound
 * HTTP/socket listener, a proxy internal, or the offline guard's own definition. Adding to this list
 * is a deliberate act with a reason, exactly as the audit intends.
 */
const KNOWN_NON_EGRESS: ReadonlyArray<readonly [string, string]> = [
  ["packages/trent-core/src/a2a/A2AServer.ts", "inbound A2A HTTP server (listener), not egress"],
  ["packages/trent-core/src/acp/ACPServer.ts", "inbound ACP HTTP server (listener)"],
  ["packages/trent-core/src/connect/loopback.ts", "inbound loopback OAuth-redirect listener bound to 127.0.0.1"],
  ["packages/trent-core/src/gateway/WebhookServer.ts", "inbound webhook HTTP server (listener)"],
  ["packages/trent-core/src/webhooks/http.ts", "inbound webhook route handler (type-only node:http)"],
  ["packages/trent-core/src/mcp-server/transport.ts", "inbound MCP server transport (listener)"],
  ["packages/trent-core/src/egress/EgressProxy.ts", "the egress proxy itself — the enforcement point; offline collapses its allowlist to loopback"],
  ["packages/trent-core/src/egress/CredentialBroker.ts", "egress-proxy internal (type-only node:http): allowlist + token swap, gated by EgressProxy"],
  ["packages/trent-core/src/egress/dial.ts", "the trentFetch offline guard's own definition"],
  ["packages/trent-core/src/doctor/checks/offline.ts", "the offline proof itself — fires the canary through the guard; it does not carry an egress path of its own"],
  ["packages/trent-core/src/tools/media/image-tool.ts", "wraps tools/media/image.ts (registered as media-image); adds no dial of its own"],
  // [D6] Newly surfaced by the widened scan — none open a socket:
  ["packages/trent-core/src/egress/CertificateAuthority.ts", "egress-proxy internal: node:net is `net.isIP` for the intercept CA's SAN encoding, not a connect"],
  ["packages/trent-core/src/egress/host-binding.ts", "node:net is `net.isIP` address classification for the broker's host-binding matcher, not a connect"],
  ["packages/trent-core/src/tools/web/url-safety.ts", "node:net is `net.isIP`/`isIPv4`/`isIPv6` for the SSRF address classifier (shared with the offline rule), not a connect"],
  ["packages/trent-core/src/tools/social/publish.ts", "the social publish routes; its bare-`fetch` fetchImpl default is always replaced by the proxied transport in tools/social/build.ts (registered as social-publish), which refuses to build the toolset without one"],
];
const KNOWN_NON_EGRESS_SET = new Set(KNOWN_NON_EGRESS.map(([path]) => path));

/** Every non-test module that references a network primitive, repo-relative, sorted. */
function networkCapableModules(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const rel = relative(REPO_ROOT, file);
    if (isTestOnly(rel)) continue;
    const text = readFileSync(file, "utf8");
    const code = stripComments(text);
    const flagged =
      NETWORK_SIGNALS.some(([, re]) => re.test(text)) || usesBareGlobalFetch(code) || usesNetworkSpawn(code);
    if (flagged) out.push(rel);
  }
  return out.sort();
}

describe("[SEC-2 S2b-1] the egress registry is well-formed", () => {
  it("gives every row a unique id", () => {
    const ids = EGRESS_PATHS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every row a real, repo-relative module path that exists on disk", () => {
    for (const path of EGRESS_PATHS) {
      expect(path.module.startsWith("packages/trent-core/src/"), path.module).toBe(true);
      expect(statSync(join(REPO_ROOT, path.module)).isFile(), path.module).toBe(true);
    }
  });

  it("only uses known dial mechanisms and offline gates", () => {
    const dials = new Set(["trentFetch", "proxy", "node:https", "socket", "subprocess"]);
    const gates = new Set(["loopback-only", "disabled", "cached-only", "config-rejected"]);
    for (const path of EGRESS_PATHS) {
      expect(dials.has(path.dials), `${path.id} dials ${path.dials}`).toBe(true);
      expect(gates.has(path.offlineGate), `${path.id} gate ${path.offlineGate}`).toBe(true);
    }
  });

  it("covers the audit's headline paths", () => {
    const ids = new Set(EGRESS_PATHS.map((p) => p.id));
    for (const required of [
      "model-openai-compat",
      "model-anthropic",
      "embedder",
      "embedder-local",
      "model-escalation",
      "connect-oauth",
      "mcp-http-oauth",
      "otel-exporter",
      "updater-release",
      "browser",
      "media-faster-whisper",
      "social-publish",
      "cron-alert",
    ]) {
      expect(ids.has(required), `missing registry row: ${required}`).toBe(true);
    }
  });

  it("partitions cleanly by gate and every row appears exactly once", () => {
    const byGate = egressPathsByGate();
    const total = (Object.values(byGate) as EgressPath[][]).reduce((n, rows) => n + rows.length, 0);
    expect(total).toBe(EGRESS_PATHS.length);
    expect(NETWORK_CAPABLE_MODULES.size).toBeLessThanOrEqual(EGRESS_PATHS.length);
  });
});

describe("[SEC-2 S2b-1] coverage — the egress surface cannot grow unregistered", () => {
  it("registers or explicitly excuses every network-capable module", () => {
    const uncovered = networkCapableModules().filter(
      (mod) => !NETWORK_CAPABLE_MODULES.has(mod) && !KNOWN_NON_EGRESS_SET.has(mod),
    );
    expect(
      uncovered,
      `these modules use a network primitive but are neither in EGRESS_PATHS nor on the KNOWN_NON_EGRESS allowlist:\n${uncovered
        .map((m) => `  - ${m}`)
        .join("\n")}\nRegister the path in egress/registry.ts (or, if it is an inbound listener/proxy internal, add it to KNOWN_NON_EGRESS with a reason).`,
    ).toEqual([]);
  });

  it("keeps the KNOWN_NON_EGRESS allowlist honest: every excused module still exists and is still flagged", () => {
    const flagged = new Set(networkCapableModules());
    for (const [mod] of KNOWN_NON_EGRESS) {
      expect(statSync(join(REPO_ROOT, mod)).isFile(), mod).toBe(true);
      expect(flagged.has(mod), `${mod} is on the allowlist but no longer uses a network primitive — remove it`).toBe(true);
    }
  });

  it("does not list a module as both registered and excused", () => {
    for (const [mod] of KNOWN_NON_EGRESS) {
      expect(NETWORK_CAPABLE_MODULES.has(mod), `${mod} is both registered and excused`).toBe(false);
    }
  });
});

/**
 * [D5] The offline proof labels every loopback-only trentFetch row "dial-proven" — meaning it is
 * covered by the single canary fired through the shared `trentFetch`. That label is only honest if
 * the module ACTUALLY routes through that transport. This is the structural identity the runtime
 * proof cannot re-check in a compiled binary, so it is asserted here where the source is present:
 * every loopback-only row's module must reference the transport its `dials` claims. A row that stops
 * routing through its transport fails CI, which is the whole point of de-circularising the proof.
 */
describe("[D5] the offline proof's per-row labels match the real wiring", () => {
  const sourceOf = (mod: string): string => readFileSync(join(REPO_ROOT, mod), "utf8");

  it("labels every loopback-only trentFetch row dial-proven and everything else honestly", () => {
    for (const path of EGRESS_PATHS) {
      const method = proofMethodFor(path);
      if (path.offlineGate === "loopback-only") {
        expect(method, path.id).toBe(path.dials === "trentFetch" ? "dial-proven" : "wiring-asserted");
      } else if (path.offlineGate === "config-rejected") {
        expect(method, path.id).toBe("config-rejected");
      } else {
        expect(method, path.id).toBe("tool-gate");
      }
    }
  });

  it("every dial-proven (trentFetch) row's module really routes through trentFetch", () => {
    for (const path of EGRESS_PATHS) {
      if (proofMethodFor(path) !== "dial-proven") continue;
      const src = sourceOf(path.module);
      expect(
        /\btrentFetch\b/.test(src) || /\bcreateTrentFetch\b/.test(src),
        `${path.id} (${path.module}) is labelled dial-proven but does not reference the shared trentFetch dial`,
      ).toBe(true);
    }
  });

  it("every wiring-asserted loopback-only row's module references the transport it claims", () => {
    for (const path of EGRESS_PATHS) {
      if (path.offlineGate !== "loopback-only" || proofMethodFor(path) !== "wiring-asserted") continue;
      const src = sourceOf(path.module);
      if (path.dials === "proxy") {
        expect(
          /\bcreateEgressFetch\b/.test(src),
          `${path.id} (${path.module}) is a proxy row but does not build its transport with createEgressFetch`,
        ).toBe(true);
      } else if (path.dials === "node:https") {
        expect(
          /from\s+["']node:https["']/.test(src),
          `${path.id} (${path.module}) is a node:https loopback row but does not import node:https`,
        ).toBe(true);
      } else {
        throw new Error(`${path.id}: unexpected wiring-asserted dial "${path.dials}" — teach this test how to verify it`);
      }
    }
  });
});
