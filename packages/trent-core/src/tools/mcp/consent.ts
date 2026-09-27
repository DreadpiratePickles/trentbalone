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
 * The file is `<profileDir>/mcp-consent.json`. It holds hashes only, never a command or a header.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "../../config/schema.js";
import type { McpToolInfo } from "./client.js";

export const MCP_CONSENT_FILE = "mcp-consent.json";
export const MCP_CONSENT_VERSION = 1;

export interface McpConsentEntry {
  /** Hash of the launch spec: server name + transport + command/args (stdio) or url (http). */
  readonly spec: string;
  /** Tool-definition hash pinned at consent time; a later mismatch is a rug pull, so a refusal. */
  readonly tools?: string;
}

export interface McpConsentRecord {
  readonly version: number;
  readonly consented: readonly McpConsentEntry[];
}

/** Canonical launch spec: key order cannot change the hash, but the command, args, url or name can. */
export function mcpLaunchSpecHash(name: string, config: McpServerConfig): string {
  const launch = config.transport === "stdio" ? [config.command, [...config.args]] : [config.url];
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
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies `mode` when it creates the file, so an existing record is re-chmodded.
  fs.chmodSync(file, 0o600);
  return record;
}

/** Records consent for one server's launch spec, pinning its tool-def hash when it is known. */
export function grantMcpConsent(profileDir: string, name: string, config: McpServerConfig, toolsHash?: string): McpConsentRecord {
  const spec = mcpLaunchSpecHash(name, config);
  const others = readMcpConsent(profileDir).consented.filter((e) => e.spec !== spec);
  return writeMcpConsent(profileDir, [...others, { spec, ...(toolsHash === undefined ? {} : { tools: toolsHash }) }]);
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
}

/** The one thing a connect asks: is this exact launch spec consented, and what tool-def hash was pinned? */
export interface McpConsentGate {
  status(name: string, config: McpServerConfig): McpConsentStatus;
}

/** The production gate: reads `<profileDir>/mcp-consent.json`. */
export function fileConsentGate(profileDir: string): McpConsentGate {
  return {
    status(name, config) {
      const spec = mcpLaunchSpecHash(name, config);
      const entry = readMcpConsent(profileDir).consented.find((e) => e.spec === spec);
      if (entry === undefined) return { consented: false };
      return { consented: true, ...(entry.tools === undefined ? {} : { toolsHash: entry.tools }) };
    },
  };
}

/**
 * A seam for operator commands and tests: consents every spec, pinning nothing. Operator-run
 * commands (`trent mcp add`, `trent mcp test`) connect deliberately, so they bypass the spawn gate;
 * tests use it to connect the fake server without a 0600 file dance.
 */
export function mcpConsentAll(): McpConsentGate {
  return { status: () => ({ consented: true }) };
}
