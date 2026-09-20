/**
 * E2: the read-only report behind `trent security audit`.
 *
 * A profile is a trust decision. It says which commands are refused outright, how often a human is
 * asked, whose code runs around every tool call, what the sandbox is, which servers may put text in
 * front of the model, and which files on disk anyone logged into the machine can read. All of that
 * is spread over `config.yaml`, four records beside it and two directories, so nobody reads it all
 * before trusting a profile. This assembles it in one pass.
 *
 * Two rules shape every section:
 *
 *   1. Nothing here is asserted. Every number is read from the real config, the real files and the
 *      real shipped rules — the hardline count comes from `HARDLINE_RULES`, "autonomy lifts no
 *      floor" is `autonomyVerdict` actually being asked, result scrubbing is `scrubMcpResult`
 *      actually being run. A report that hard-coded its own answers would pass its tests forever
 *      and tell a user nothing about their machine.
 *   2. A finding names what is wrong, never the thing that is wrong with it. The config-secrets
 *      section reports the KEY and the line number of a credential-shaped value and never the
 *      value, because a security report is exactly the file a user pastes into a chat.
 *
 * Nothing here writes. The command is safe on a machine nobody is sitting at, which is the only
 * way it gets run in CI.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyAuditExport } from "../audit/verify.js";
import { auditKeyExists, publicKeyFingerprint, readAuditPublicKey } from "../audit/signing.js";
import type { TrentConfig } from "../config/schema.js";
import { consentPath, hookSpecHash, readConsent } from "../hooks/consent.js";
import { HOOK_KINDS } from "../hooks/types.js";
import { redactionRuleNames } from "../telemetry/redact.js";
import { scrubMcpResult } from "../tools/mcp/scan.js";
import { defaultPluginsDir } from "../tools/plugins/index.js";
import { loadPluginManifests } from "../tools/plugins/manifest.js";
import { workspaceStatus } from "../workspace-context/index.js";
import { autonomyVerdict, type AutonomyLevel } from "./autonomy.js";
import { floorClasses } from "./gate-config-schema.js";
import type { PolicyClass } from "./policy-rules.js";
import { HARDLINE_RULES } from "./hardline.js";
import { auditConfigSecrets, auditFilePermissions, octal } from "./security-audit-files.js";

/** Sections in report order. The command renders them in this order and so does `--json`. */
export const SECURITY_SECTION_IDS = [
  "autonomy",
  "approvals",
  "hooks",
  "egress",
  "workspace",
  "redaction",
  "mcp",
  "plugins",
  "audit-chain",
  "file-permissions",
  "config-secrets",
] as const;

export type SecuritySectionId = (typeof SECURITY_SECTION_IDS)[number];

/** `critical` is "a credential is exposed"; `low` is "worth knowing before you trust this". */
export type SecuritySeverity = "critical" | "high" | "medium" | "low";

const SEVERITY_ORDER: readonly SecuritySeverity[] = ["critical", "high", "medium", "low"];

export interface SecurityFinding {
  readonly id: string;
  readonly section: SecuritySectionId;
  readonly severity: SecuritySeverity;
  /** What is wrong, in one line, naming the subject but never a secret value. */
  readonly message: string;
  /** What to do about it. Never empty: a finding with no fix is a complaint. */
  readonly fix: string;
}

export interface SecuritySection {
  readonly id: SecuritySectionId;
  readonly title: string;
  readonly details: Record<string, unknown>;
}

export interface SecurityAuditReport {
  readonly profile: string;
  readonly profileDir: string;
  readonly ok: boolean;
  readonly sections: readonly SecuritySection[];
  readonly findings: readonly SecurityFinding[];
}

export interface SecurityAuditInput {
  readonly profile: string;
  readonly profileDir: string;
  readonly configPath: string;
  readonly secretsPath: string;
  readonly config: TrentConfig;
  /** The directory whose workspace trust is reported; the working directory in the CLI. */
  readonly cwd: string;
  readonly home: string;
  /** A signed audit export to re-verify with `trent audit verify`'s own logic. */
  readonly auditExport?: string;
}

/** How a section hands back what it found. Implemented once, in `auditProfileSecurity`. */
export interface SecurityAuditCollector {
  section(id: SecuritySectionId, title: string, details: Record<string, unknown>): void;
  finding(finding: SecurityFinding): void;
}

// ------------------------------------------------------------------ autonomy

/** The three floors below every level. Probed, not assumed: the verdict function is asked. */
const FLOOR_PROBES: ReadonlyArray<{ readonly name: string; readonly ask: (level: AutonomyLevel) => string }> = [
  {
    name: "hardline",
    ask: (level) =>
      autonomyVerdict({ level, hardline: { id: "probe", reason: "probe" }, deny: null, floor: null, adapterAsks: false, pureRead: false })
        .outcome,
  },
  {
    name: "approvals.deny",
    ask: (level) =>
      autonomyVerdict({ level, hardline: null, deny: { glob: "probe", subject: "probe" }, floor: null, adapterAsks: false, pureRead: false })
        .outcome,
  },
  {
    name: "approval-floor",
    ask: (level) =>
      autonomyVerdict({ level, hardline: null, deny: null, floor: "probe", adapterAsks: false, pureRead: false }).outcome,
  },
];

/** [U1] The class floor asks rather than refuses; it is probed the same way, at the configured level. */
function classFloorStillAsks(level: AutonomyLevel, floor: readonly PolicyClass[]): boolean {
  return floor.every(
    (cls) => autonomyVerdict({ level, hardline: null, deny: null, floor: null, adapterAsks: false, pureRead: false, classFloor: [cls] }).outcome === "ask",
  );
}

function auditAutonomy(config: TrentConfig, out: SecurityAuditCollector): void {
  const level = config.autonomy;
  const floorsStillRefusing = FLOOR_PROBES.filter((probe) => probe.ask(level) === "refuse").map((probe) => probe.name);
  const liftsAnyFloor = floorsStillRefusing.length !== FLOOR_PROBES.length;
  const classFloor = floorClasses(config.gate);
  out.section("autonomy", "Autonomy level", { level, liftsAnyFloor, floorsStillRefusing, classFloor, classFloorStillAsks: classFloorStillAsks(level, classFloor) });

  if (level === "never") {
    out.finding({
      id: "autonomy-never",
      section: "autonomy",
      severity: "high",
      message: `autonomy is "never", so every call the approval floors would have asked a human about runs unattended, except a call on the class floor (${classFloor.join(", ")}), which still asks`,
      fix: "trent config set autonomy ask_dangerous",
    });
  }
}

// ------------------------------------------------------------------ approvals

function auditApprovals(config: TrentConfig, out: SecurityAuditCollector): void {
  const body = HARDLINE_RULES.map((rule) => `${rule.id}\n${rule.reason}`).join("\n");
  out.section("approvals", "Deny globs and the hardline list", {
    denyGlobs: [...config.approvals.deny],
    hardlineCount: HARDLINE_RULES.length,
    hardlineHash: createHash("sha256").update(body).digest("hex"),
    hardlineRules: HARDLINE_RULES.map((rule) => rule.id),
  });
}

// ---------------------------------------------------------------------- hooks

function auditHooks(input: SecurityAuditInput, out: SecurityAuditCollector): void {
  const consented = new Set(readConsent(input.profileDir).consented);
  const hooks: Array<{ kind: string; command: string; consented: boolean }> = [];
  for (const kind of HOOK_KINDS) {
    for (const spec of input.config.hooks[kind]) {
      const isConsented = consented.has(hookSpecHash(kind, spec));
      hooks.push({ kind, command: spec.command.join(" "), consented: isConsented });
      if (isConsented) continue;
      out.finding({
        id: "hook-not-consented",
        section: "hooks",
        severity: "medium",
        message: `the ${kind} hook "${spec.command.join(" ")}" is in config.yaml but its exact spec is not in the consent record, so it never runs`,
        fix: "trent hooks list, then trent hooks consent to record it - or delete it from config.yaml",
      });
    }
  }
  out.section("hooks", "User hooks and their consent", {
    consentFile: consentPath(input.profileDir),
    total: hooks.length,
    consented: hooks.filter((hook) => hook.consented).length,
    unconsented: hooks.filter((hook) => !hook.consented).length,
    hooks,
  });
}

// --------------------------------------------------------------------- egress

const BACKEND_MEANING: Readonly<Record<string, string>> = {
  docker: "commands run in a container with no host filesystem and no host environment",
  local: "commands run on this host, with this host's environment; it is not a sandbox",
};

function auditEgress(config: TrentConfig, out: SecurityAuditCollector): void {
  const backend = config.terminal.backend;
  out.section("egress", "Egress proxy and sandbox backend", {
    enabled: config.egress.enabled,
    proxyPort: config.egress.proxy_port,
    autoToken: config.egress.auto_token,
    interceptDomains: [...config.egress.intercept_domains],
    sandboxBackend: backend,
    sandboxMeaning: BACKEND_MEANING[backend] ?? "",
  });

  if (!config.egress.enabled) {
    out.finding({
      id: "egress-proxy-disabled",
      section: "egress",
      severity: "medium",
      message: "the egress proxy is off, so nothing brokers the credentials a tool's outbound request carries",
      fix: "trent config set egress.enabled true",
    });
  }
  if (backend === "local") {
    out.finding({
      id: "sandbox-backend-local",
      section: "egress",
      severity: "high",
      message: `the terminal backend is "local", so ${BACKEND_MEANING.local}`,
      fix: "trent config set terminal.backend docker, then trent sandbox build",
    });
  }
}

// ------------------------------------------------------------------ workspace

function auditWorkspace(input: SecurityAuditInput, out: SecurityAuditCollector): void {
  let status: ReturnType<typeof workspaceStatus>;
  try {
    status = workspaceStatus({ cwd: input.cwd, profileDir: input.profileDir, config: input.config });
  } catch (error) {
    out.section("workspace", "Workspace trust for this directory", {
      cwd: input.cwd,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  out.section("workspace", "Workspace trust for this directory", {
    cwd: status.cwd,
    workspaceRoot: status.workspaceRoot,
    trusted: status.trusted,
    trustedAt: status.trustedAt,
    changedSinceTrusted: status.changedSinceTrusted,
    files: status.files.length,
    refused: status.refused.length,
    trustFile: status.trustFile,
  });

  if (status.trusted && status.changedSinceTrusted) {
    out.finding({
      id: "workspace-changed-since-trusted",
      section: "workspace",
      severity: "medium",
      message: `the instruction files in ${status.workspaceRoot} have changed since trust was granted, and they reach every prompt`,
      fix: `review them with trent workspace status ${status.workspaceRoot}, then re-grant with trent workspace trust`,
    });
  }
}

// ------------------------------------------------------------------ redaction

function auditRedaction(config: TrentConfig, out: SecurityAuditCollector): void {
  out.section("redaction", "Prompt redaction", {
    redactPrompts: config.privacy.redact_prompts,
    extraPatterns: config.privacy.patterns.length,
    detectors: redactionRuleNames(),
  });
}

// ------------------------------------------------------------------------ mcp

function auditMcp(config: TrentConfig, out: SecurityAuditCollector): void {
  // Measured, not declared: the scrubber the MCP client runs over every tool result is run here.
  const probe = scrubMcpResult("Authorization: Bearer 0123456789abcdefghij");
  const servers = Object.entries(config.mcp_servers).map(([name, server]) => ({
    name,
    transport: server.transport,
    enabled: server.enabled,
    autoApprove: server.auto_approve.length,
    scanned: server.scanRan === true,
    flagged: (server.flagged ?? []).map((finding) => finding.tool),
  }));

  out.section("mcp", "MCP servers", {
    total: servers.length,
    resultScrubbing: probe.hits.length > 0,
    scrubDetectors: redactionRuleNames(),
    servers,
  });

  for (const server of servers) {
    if (server.flagged.length > 0) {
      out.finding({
        id: "mcp-server-flagged-tools",
        section: "mcp",
        severity: "high",
        message: `MCP server "${server.name}" was installed over ${server.flagged.length} flagged tool(s): ${server.flagged.join(", ")}`,
        fix: `trent mcp remove ${server.name}, or re-add it without --allow-flagged once the server's tool descriptions are clean`,
      });
      continue;
    }
    if (!server.scanned) {
      out.finding({
        id: "mcp-server-unscanned",
        section: "mcp",
        severity: "medium",
        message: `MCP server "${server.name}" has no install-time scan record, so its tool descriptions were never checked`,
        fix: `trent mcp remove ${server.name} and add it again with trent mcp add, which scans before it writes`,
      });
    }
  }
}

// -------------------------------------------------------------------- plugins

function auditPlugins(input: SecurityAuditInput, out: SecurityAuditCollector): void {
  const dir = defaultPluginsDir(input.profileDir);
  const report = loadPluginManifests(dir);

  out.section("plugins", "Plugin manifests", {
    dir,
    loaded: report.plugins.length,
    refused: report.refused.length,
    plugins: report.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      tools: plugin.tools.map((tool) => tool.schema.name),
      manifestMode: manifestMode(plugin.dir),
    })),
    refusals: report.refused.map((refusal) => ({ plugin: refusal.plugin, reason: refusal.reason })),
  });

  for (const refusal of report.refused) {
    out.finding({
      id: "plugin-manifest-refused",
      section: "plugins",
      severity: "medium",
      message: `the plugin manifest "${refusal.plugin}" is refused: ${refusal.reason}`,
      fix: `fix ${path.join(dir, refusal.plugin, "plugin.json")} or remove the directory; a refused manifest registers no tools`,
    });
  }
}

// ---------------------------------------------------------------- audit chain

async function auditChain(input: SecurityAuditInput, out: SecurityAuditCollector): Promise<void> {
  const ownKey = readAuditPublicKey(input.profileDir);
  let fingerprint: string | null = null;
  try {
    fingerprint = ownKey === null ? null : publicKeyFingerprint(ownKey);
  } catch {
    fingerprint = null;
  }

  const base = { keyPresent: auditKeyExists(input.profileDir), fingerprint, exportFile: input.auditExport ?? null };
  if (input.auditExport === undefined) {
    out.section("audit-chain", "Signed audit chain", { ...base, verified: null });
    return;
  }

  try {
    const report = await verifyAuditExport(input.auditExport, ownKey === null ? {} : { trustedPublicKeyPem: ownKey });
    out.section("audit-chain", "Signed audit chain", {
      ...base,
      verified: report.ok,
      rows: report.rows,
      signer: report.signer,
      trusted: ownKey !== null && report.signer !== "" && fingerprint === report.signer,
      failures: report.failures.map((failure) => failure.message),
    });
    if (report.ok) return;
    out.finding({
      id: "audit-export-unverified",
      section: "audit-chain",
      severity: "critical",
      message: `the audit export ${input.auditExport} does not verify: ${report.failures.map((f) => f.message).join("; ")}`,
      fix: `re-export with trent audit export --out ${input.auditExport} and keep the .sig beside it`,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    out.section("audit-chain", "Signed audit chain", { ...base, verified: false, failures: [reason] });
    out.finding({
      id: "audit-export-unverified",
      section: "audit-chain",
      severity: "critical",
      message: `the audit export ${input.auditExport} could not be read: ${reason}`,
      fix: "trent audit export --out <file>, then re-run the audit against that file",
    });
  }
}

// ------------------------------------------------------------------- assembly

function manifestMode(dir: string): string {
  try {
    return octal(fs.statSync(path.join(dir, "plugin.json")).mode);
  } catch {
    return "";
  }
}

/** Every section, in `SECURITY_SECTION_IDS` order, with the findings sorted most severe first. */
export async function auditProfileSecurity(input: SecurityAuditInput): Promise<SecurityAuditReport> {
  const sections: SecuritySection[] = [];
  const findings: SecurityFinding[] = [];
  const out: SecurityAuditCollector = {
    section: (id, title, details) => sections.push({ id, title, details }),
    finding: (finding) => findings.push(finding),
  };

  auditAutonomy(input.config, out);
  auditApprovals(input.config, out);
  auditHooks(input, out);
  auditEgress(input.config, out);
  auditWorkspace(input, out);
  auditRedaction(input.config, out);
  auditMcp(input.config, out);
  auditPlugins(input, out);
  await auditChain(input, out);
  auditFilePermissions(input, out);
  auditConfigSecrets(input, out);

  const order = new Map(SECURITY_SECTION_IDS.map((id, index) => [id, index]));
  sections.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  return { profile: input.profile, profileDir: input.profileDir, ok: findings.length === 0, sections, findings };
}
