/**
 * [T-08] Consent before spawn for stdio MCP servers.
 *
 * A stdio MCP server is arbitrary host code: `StdioClientTransport` spawns the configured command
 * the moment a connect begins, so the install-time scan (which runs only after connecting) is too
 * late to stop code that should never have run. This is the same problem hook consent solves
 * (`hooks/consent.ts`), and the shape is deliberately the same: a record of hashes, written 0600,
 * that says nothing useful to an attacker who reads it.
 *
 * A launch spec — the command and args (or, for http, the URL), scoped by the server name — is
 * consented by an explicit operator step (`trent mcp add` records it; `trent mcp consent` re-records
 * it). Without a matching consent, `connectMcpServer` REFUSES a stdio server before anything is
 * spawned. At consent time the server's tool-definition hash is pinned too: if a later connect sees
 * tool definitions whose hash differs (a rug pull — descriptions the seat reads as instructions,
 * quietly changed after approval), the connect refuses rather than trust them.
 *
 * [D13] http servers get the same gate: no recorded consent, no connect (nothing is sent). An http
 * consent is keyed on the normalized URL, origin plus path: a query string (which may carry a
 * secret), URL credentials and headers are never part of the key and never written. When the consent
 * step could not reach the server (the CLI runs no egress proxy), the tool-definition hash is pinned
 * on the first consented connect instead, and every later connect is held to it.
 *
 * [D13] A stdio consent also records an artifact pin (`./artifact.ts`): an exact package version, an
 * image digest, or a content digest of the script or binary. A spawn whose artifact no longer matches
 * is refused, and a record written before the pin existed (version 1, no `artifact`) is treated as
 * needing re-consent rather than trusted.
 *
 * The file is `<profileDir>/mcp-consent.json`. It holds hashes only, never a command, a URL or a header.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "../../config/schema.js";
import type { McpArtifactPin } from "./artifact.js";
import type { McpToolInfo } from "./client.js";

export const MCP_CONSENT_FILE = "mcp-consent.json";
/** 2: stdio entries carry `artifact` [D13]. A version-1 stdio entry has none, so it needs re-consent. */
export const MCP_CONSENT_VERSION = 2;

export interface McpConsentEntry {
  /** Hash of the launch spec: server name + transport + command/args (stdio) or url (http). */
  readonly spec: string;
  /** Tool-definition hash pinned at consent time; a later mismatch is a rug pull, so a refusal. */
  readonly tools?: string;
  /** [D13] stdio only: what the consented launch actually runs (a version, an image digest, or content digests). */
  readonly artifact?: McpArtifactPin;
}

export interface McpConsentRecord {
  readonly version: number;
  readonly consented: readonly McpConsentEntry[];
}

/**
 * [D13] The part of an http URL a consent is keyed on: origin plus path. The query string and any
 * `user:password@` are dropped (either may carry a secret), and the host is lowercased by the parser.
 */
export function normalizeMcpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

/** Canonical launch spec: key order cannot change the hash, but the command, args, url or name can. */
export function mcpLaunchSpecHash(name: string, config: McpServerConfig): string {
  const launch = config.transport === "stdio" ? [config.command, [...config.args]] : [normalizeMcpUrl(config.url)];
  const canonical = JSON.stringify([name, config.transport, ...launch]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Order-independent hash of the strings a server hands the seat as instructions: each tool's name,
 * description and input schema. Sorting by name means the pin does not turn over when a server
 * merely reorders its tool list.
 */
export function mcpToolDefHash(tools: readonly McpToolInfo[]): string {
  const canonical = JSON.stringify(
    [...tools].map((t) => [t.name, t.description, t.inputSchema]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export function mcpConsentPath(profileDir: string): string {
  return path.join(profileDir, MCP_CONSENT_FILE);
}

/** A missing or unreadable record is NO consent, never an error: the safe direction is silence. */
export function readMcpConsent(profileDir: string): McpConsentRecord {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(mcpConsentPath(profileDir), "utf8"));
    if (!raw || typeof raw !== "object") return { version: MCP_CONSENT_VERSION, consented: [] };
    const entries = (raw as { consented?: unknown }).consented;
    const consented = Array.isArray(entries)
      ? entries.filter((e): e is McpConsentEntry => !!e && typeof e === "object" && typeof (e as { spec?: unknown }).spec === "string")
      : [];
    const version = (raw as { version?: unknown }).version;
    return { version: typeof version === "number" ? version : MCP_CONSENT_VERSION, consented };
  } catch {
    return { version: MCP_CONSENT_VERSION, consented: [] };
  }
}

export function writeMcpConsent(profileDir: string, entries: readonly McpConsentEntry[]): McpConsentRecord {
  fs.mkdirSync(profileDir, { recursive: true });
  // One entry per spec: a re-consent replaces, never appends.
  const byspec = new Map<string, McpConsentEntry>();
  for (const entry of entries) byspec.set(entry.spec, entry);
  const record: McpConsentRecord = { version: MCP_CONSENT_VERSION, consented: [...byspec.values()] };
  const file = mcpConsentPath(profileDir);
  // Write-then-rename: a reader (a seat pinning tool defs on first connect) never sees half a record.
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  return record;
}

/**
 * Records consent for one server's launch spec, pinning its tool-def hash when it is known and, for
 * stdio, the artifact it runs (`resolveMcpArtifact`). A stdio consent without an artifact is written
 * but refused at spawn time, so callers resolve the artifact first.
 */
export function grantMcpConsent(profileDir: string, name: string, config: McpServerConfig, toolsHash?: string, artifact?: McpArtifactPin): McpConsentRecord {
  const spec = mcpLaunchSpecHash(name, config);
  const others = readMcpConsent(profileDir).consented.filter((e) => e.spec !== spec);
  const entry: McpConsentEntry = { spec, ...(toolsHash === undefined ? {} : { tools: toolsHash }), ...(artifact === undefined ? {} : { artifact }) };
  return writeMcpConsent(profileDir, [...others, entry]);
}

/** Drops consent for one server's launch spec; returns whether anything was recorded for it. */
export function revokeMcpConsent(profileDir: string, name: string, config: McpServerConfig): boolean {
  const spec = mcpLaunchSpecHash(name, config);
  const before = readMcpConsent(profileDir).consented;
  const after = before.filter((e) => e.spec !== spec);
  if (after.length === before.length) return false;
  writeMcpConsent(profileDir, after);
  return true;
}

/** What a connect learns about a server: whether its launch spec is consented, and any pinned hash. */
export interface McpConsentStatus {
  readonly consented: boolean;
  readonly toolsHash?: string;
  /** [D13] stdio: the artifact pin recorded with the consent; absent on a pre-D13 record. */
  readonly artifact?: McpArtifactPin;
  /** [D13] An operator-run connect (`mcp add|test|consent`): no artifact check, nothing pinned. */
  readonly operator?: boolean;
}

/** The one thing a connect asks: is this exact launch spec consented, and what tool-def hash was pinned? */
export interface McpConsentGate {
  status(name: string, config: McpServerConfig): McpConsentStatus;
  /** [D13] Pins the tool-def hash of a consented server that has none yet (first connect). */
  pinTools?(name: string, config: McpServerConfig, toolsHash: string): void;
}

function isArtifactPin(value: unknown): value is McpArtifactPin {
  if (!value || typeof value !== "object") return false;
  const pin = value as Record<string, unknown>;
  return (pin.kind === "package" || pin.kind === "file" || pin.kind === "inline") && typeof pin.digest === "string" && (pin.stat === undefined || typeof pin.stat === "string");
}

/** The production gate: reads `<profileDir>/mcp-consent.json`. */
export function fileConsentGate(profileDir: string): McpConsentGate {
  return {
    status(name, config) {
      const spec = mcpLaunchSpecHash(name, config);
      const entry = readMcpConsent(profileDir).consented.find((e) => e.spec === spec);
      if (entry === undefined) return { consented: false };
      // A malformed pin is no pin: the connect then asks for re-consent instead of trusting it.
      const artifact = isArtifactPin(entry.artifact) ? entry.artifact : undefined;
      return { consented: true, ...(typeof entry.tools === "string" ? { toolsHash: entry.tools } : {}), ...(artifact === undefined ? {} : { artifact }) };
    },
    pinTools(name, config, toolsHash) {
      const spec = mcpLaunchSpecHash(name, config);
      const entries = readMcpConsent(profileDir).consented;
      const entry = entries.find((e) => e.spec === spec);
      if (entry === undefined || entry.tools !== undefined) return;
      writeMcpConsent(profileDir, entries.map((e) => (e === entry ? { ...e, tools: toolsHash } : e)));
    },
  };
}

/**
 * A seam for operator commands and tests: consents every spec, pinning nothing. Operator-run
 * commands (`trent mcp add`, `trent mcp test`) connect deliberately, so they bypass the spawn gate;
 * tests use it to connect the fake server without a 0600 file dance.
 */
export function mcpConsentAll(): McpConsentGate {
  return { status: () => ({ consented: true, operator: true }) };
}
