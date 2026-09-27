/**
 * [D16] The per-run security receipt (SEC-5 S5.2): what security actually did during one run.
 *
 * A pure function from the run's collected record (`security-receipt-collector.ts`) to a view with a
 * stable JSON shape, and a second pure function from that view to the human ledger `trent run` prints
 * as its footer. Nothing here enforces anything, reads a file or opens a socket: every number is a
 * count of an event a real gate produced — an `EgressProxy` decision, a `CredentialBroker` injection,
 * a provenance tag, a hold or refusal record from the dispatch chain.
 *
 * NEVER A SECRET. The record holds hosts, provider names, tool names from the build's own vocabulary,
 * and rule identifiers parsed off the gates' fixed-format summaries. It never holds a header, a token,
 * an action's arguments or a tool summary, so there is no field a secret value could ride in
 * (`security-receipt.sentinel.test.ts` proves it end to end through a real proxy).
 */

/** Where a hold came from: the provenance gate, the [U1] class floor, or an ordinary approval. */
export type HoldKind = "provenance" | "class_floor" | "approval";

/** Which gate refused: the hardline list, an `approvals.deny` glob, the approval floor, provenance, or another adapter's own block. */
export type RefusalKind = "hardline" | "deny_glob" | "approval_floor" | "provenance" | "other";

export interface EgressHostTally {
  readonly host: string;
  readonly allowed: number;
  readonly refused: number;
  /** The proxy's reason code for each refusal of this host (`host_not_allowlisted`, ...), without repeats. */
  readonly rules: readonly string[];
}

export interface NamedCount {
  readonly tool: string;
  readonly calls: number;
}

/** What the collector hands the view: plain data, so the view is testable without a run. */
export interface RunSecurityRecord {
  readonly offline: boolean;
  readonly backend: "docker" | "local";
  readonly egress: {
    readonly state: "on" | "off" | "failed";
    readonly hosts: readonly EgressHostTally[];
    /** Hosts past the collector's cap, folded into one bucket so a long run cannot grow the record. */
    readonly otherHosts: { readonly allowed: number; readonly refused: number; readonly count: number };
  };
  /** The provider whose key the broker held, and what it did with it. Names only, never a value. */
  readonly credentials: ReadonlyArray<{ readonly provider: string; readonly injected: number; readonly withheld: number }>;
  /** Calls whose own result the provenance gate tagged untrusted, by tool. */
  readonly untrusted: readonly NamedCount[];
  /** Whether a network-derived command wrote into this run's workspace (`tools/terminal/taint.ts`). */
  readonly networkDerivedWorkspace: boolean;
  readonly tools: readonly NamedCount[];
  readonly holds: ReadonlyArray<{ readonly kind: HoldKind; readonly tool: string; readonly count: number }>;
  readonly refusals: ReadonlyArray<{ readonly kind: RefusalKind; readonly rule: string; readonly tool: string; readonly count: number }>;
}

/** The receipt's JSON shape: `securityReceipt` on `trent run --json` and on the stream's `result` line. */
export interface SecurityReceipt {
  readonly version: 1;
  readonly offline: boolean;
  /** `isolated` is false on the local backend: nothing stands between a command and this machine. */
  readonly terminal: { readonly backend: "docker" | "local"; readonly isolated: boolean };
  readonly egress: {
    readonly proxy: "on" | "off" | "failed";
    readonly allowed: number;
    readonly refused: number;
    readonly hosts: readonly EgressHostTally[];
    /** Distinct hosts past the cap; their requests are still in `allowed` and `refused`. */
    readonly otherHosts: number;
  };
  readonly credentials: ReadonlyArray<{ readonly provider: string; readonly injected: number; readonly withheld: number }>;
  readonly provenance: { readonly untrustedCalls: number; readonly untrustedSources: readonly NamedCount[]; readonly networkDerivedWorkspace: boolean };
  readonly tools: readonly NamedCount[];
  readonly holds: { readonly total: number; readonly entries: RunSecurityRecord["holds"] };
  readonly refusals: { readonly total: number; readonly entries: RunSecurityRecord["refusals"] };
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Most-used first, then by name: a stable order for the same record. */
function byCalls(values: readonly NamedCount[]): NamedCount[] {
  return values.map((v) => ({ ...v })).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

export function buildSecurityReceipt(record: RunSecurityRecord): SecurityReceipt {
  const hosts = record.egress.hosts.map((h) => ({ ...h, rules: [...h.rules] })).sort((a, b) => a.host.localeCompare(b.host));
  const other = record.egress.otherHosts;
  return {
    version: 1,
    offline: record.offline,
    terminal: { backend: record.backend, isolated: record.backend === "docker" },
    egress: {
      proxy: record.egress.state,
      allowed: sum(hosts.map((h) => h.allowed)) + other.allowed,
      refused: sum(hosts.map((h) => h.refused)) + other.refused,
      hosts,
      otherHosts: other.count,
    },
    credentials: record.credentials.map((c) => ({ ...c })),
    provenance: {
      untrustedCalls: sum(record.untrusted.map((u) => u.calls)),
      untrustedSources: byCalls(record.untrusted),
      networkDerivedWorkspace: record.networkDerivedWorkspace,
    },
    tools: byCalls(record.tools),
    holds: { total: sum(record.holds.map((h) => h.count)), entries: record.holds.map((h) => ({ ...h })) },
    refusals: { total: sum(record.refusals.map((r) => r.count)), entries: record.refusals.map((r) => ({ ...r })) },
  };
}

const LABEL_WIDTH = 11;
const row = (label: string, text: string): string => `  ${label.padEnd(LABEL_WIDTH)}${text}`;
const more = (text: string): string => `  ${" ".repeat(LABEL_WIDTH)}${text}`;
const counted = (values: readonly NamedCount[]): string => values.map((v) => `${v.tool} ×${v.calls}`).join(", ");

function egressLines(egress: SecurityReceipt["egress"]): string[] {
  if (egress.proxy === "off") return [row("egress", "proxy off: the tools had no network")];
  if (egress.proxy === "failed") return [row("egress", "proxy FAILED to start: the tools had no network")];
  if (egress.allowed + egress.refused === 0) return [row("egress", "proxy on · no requests")];
  const lines = [row("egress", `proxy on · ${egress.allowed} allowed · ${egress.refused} refused`)];
  const allowed = egress.hosts.filter((h) => h.allowed > 0);
  const refused = egress.hosts.filter((h) => h.refused > 0);
  if (allowed.length > 0) lines.push(more(`allowed  ${allowed.map((h) => `${h.host} ×${h.allowed}`).join(", ")}`));
  for (const h of refused) lines.push(more(`refused  ${h.host} ×${h.refused} (${h.rules.join(", ")})`));
  if (egress.otherHosts > 0) lines.push(more(`and ${egress.otherHosts} more host(s), counted above`));
  return lines;
}

/** The footer: one short ledger of what the run was allowed to touch and what was stopped. */
export function renderSecurityReceipt(receipt: SecurityReceipt): string[] {
  const lines = ["Security receipt", ...egressLines(receipt.egress)];
  for (const c of receipt.credentials) {
    lines.push(row("secrets", `${c.provider} key held by the broker: injected into ${c.injected} request(s), withheld from ${c.withheld}; the value is never shown`));
  }
  const p = receipt.provenance;
  const untrusted = p.untrustedCalls === 0 ? "no untrusted input" : `${p.untrustedCalls} call(s): ${counted(p.untrustedSources)}`;
  lines.push(row("untrusted", `${untrusted}${p.networkDerivedWorkspace ? " · workspace network-derived" : ""}`));
  const holds = receipt.holds.entries.map((h) => `${h.kind.replace("_", " ")} hold: ${h.tool}${h.count > 1 ? ` ×${h.count}` : ""}`);
  lines.push(row("holds", holds.length === 0 ? "none" : `${receipt.holds.total} · ${holds.join(", ")}`));
  const refusals = receipt.refusals.entries.map((r) => `${r.kind.replace("_", " ")} ${r.rule}: ${r.tool}${r.count > 1 ? ` ×${r.count}` : ""}`);
  lines.push(row("refusals", refusals.length === 0 ? "none" : `${receipt.refusals.total} · ${refusals.join("; ")}`));
  if (receipt.tools.length > 0) lines.push(row("tools", counted(receipt.tools)));
  const terminal = receipt.terminal.isolated ? `terminal ${receipt.terminal.backend}` : `terminal ${receipt.terminal.backend} (not isolated)`;
  lines.push(row("posture", `offline ${receipt.offline ? "on" : "off"} · ${terminal}`));
  return lines;
}
