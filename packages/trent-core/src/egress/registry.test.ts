/**
 * [SEC-2 S2b-1] The coverage guarantee: the enumerated egress surface cannot silently grow.
 *
 * This walks every non-test source file under packages/trent-core/src, flags each one that imports or
 * uses a network primitive (a `trentFetch`/`createEgressFetch` dial, `node:http`/`node:https`, a
 * `WebSocket`, a `net`/`tls` connect), and asserts every flagged module is either a registered
 * {@link EGRESS_PATHS} row or on the curated {@link KNOWN_NON_EGRESS} allowlist of paths that are
 * inbound listeners or proxy internals, not egress. A new hosted-egress module that is registered in
 * neither list fails this test — so adding egress without enumerating it breaks CI.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EGRESS_PATHS, NETWORK_CAPABLE_MODULES, egressPathsByGate, type EgressPath } from "./registry.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SRC_DIR, "../../..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** A network primitive, matched on file text. Each signal is the thing that can open a socket. */
const NETWORK_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ["trentFetch", /\btrentFetch\b/],
  ["createEgressFetch", /\bcreateEgressFetch\b/],
  ["node:https", /from\s+["']node:https["']/],
  ["node:http", /from\s+["']node:http["']/],
  ["WebSocket", /new\s+WebSocket\s*\(/],
  ["ws-module", /from\s+["']ws["']/],
  ["net.connect", /\bnet\.connect\s*\(/],
  ["tls.connect", /\btls\.connect\s*\(/],
  ["createConnection", /\bcreateConnection\s*\(/],
  ["net.Socket", /new\s+net\.Socket\b/],
];

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
];
const KNOWN_NON_EGRESS_SET = new Set(KNOWN_NON_EGRESS.map(([path]) => path));

/** Every non-test module that references a network primitive, repo-relative, sorted. */
function networkCapableModules(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const rel = relative(REPO_ROOT, file);
    if (isTestOnly(rel)) continue;
    const text = readFileSync(file, "utf8");
    if (NETWORK_SIGNALS.some(([, re]) => re.test(text))) out.push(rel);
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
