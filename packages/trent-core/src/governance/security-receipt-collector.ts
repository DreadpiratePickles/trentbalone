/**
 * [D16] The run's security collector: small counters fed by the gates that already exist, read once
 * when the run ends and handed to `buildSecurityReceipt`. It observes; it never decides.
 *
 * Its inlets, each an existing source:
 *   - `egressDecision`: the `EgressProxy` `onDecision` hook, one call per request the proxy allowed or
 *     refused, carrying the refusal's reason code and whether the `CredentialBroker` injected or
 *     withheld the key;
 *   - `observeLedger`: the provenance ledger the tool build writes to, whose `note` receives each
 *     call's OWN tag (before a tainted step's later calls inherit it);
 *   - `observeAdapters`: the built adapters, whose records carry the dispatch chain's own hold and
 *     refusal results, in the fixed formats `governance/autonomy.ts` and `provenance.ts` write;
 *   - the snapshot reads the workspace marker (`tools/terminal/taint.ts`) when it is taken.
 *
 * Every inlet swallows its own failures: an observer that throws must never fail the call, the
 * request or the run it observed. Every string it keeps is a host (control bytes stripped, capped),
 * a provider name, a tool name from the build's own vocabulary, or a rule id — never an argument,
 * a header, a token or a summary.
 */
import { isNetworkDerived } from "../tools/terminal/taint.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import type { EgressDecision } from "../egress/EgressProxy.js";
import { toolNameOf } from "./idempotent-dispatch.js";
import type { ProvenanceLedger } from "./provenance.js";
import type { HoldKind, NamedCount, RefusalKind, RunSecurityRecord } from "./security-receipt.js";

export interface RunSecurityCollectorOptions {
  readonly backend: "docker" | "local";
  readonly offline: boolean;
  readonly egressState: "on" | "off" | "failed";
  /** The provider whose key was handed to the broker for this run; absent when none was. */
  readonly credentialProvider?: string;
  /** The run's workspace, for the network-derived marker. */
  readonly workspace?: string;
  /** Overrides the marker read (tests). */
  readonly isNetworkDerived?: () => boolean;
  /** Distinct hosts kept by name; the rest are folded into one bucket. Default 64. */
  readonly maxHosts?: number;
}

export interface RunSecurityCollector {
  egressDecision(decision: EgressDecision): void;
  setEgressState(state: "on" | "off" | "failed", credentialProvider?: string): void;
  /** The names a tool may be reported by: every adapter name and declared scope of the build. */
  knowTools(names: Iterable<string>): void;
  observeLedger(ledger: ProvenanceLedger): ProvenanceLedger;
  observeAdapters(adapters: readonly TrentToolAdapter[]): TrentToolAdapter[];
  snapshot(): RunSecurityRecord;
}

export type ToolRecordClass =
  | { readonly outcome: "refusal"; readonly kind: RefusalKind; readonly rule: string }
  | { readonly outcome: "hold"; readonly kind: HoldKind };

const UNLISTED_TOOL = "(unlisted tool)";
const MAX_LABEL = 120;
/** Distinct folded hosts remembered only to count them; past this the count stops growing. */
const MAX_FOLDED_NAMES = 4096;

/** Printable, bounded: a host or rule taken from outside can neither drive the terminal nor grow the record. */
function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, MAX_LABEL);
}

// The gates' own summary formats. `autonomy.ts`: "Hardline rule <id>: ...", "Refused by approvals.deny
// glob <glob>, which matched: <subject>", "Approval floor: <label>. This is never ...", "<a>: Class floor:
// ..."; `provenance.ts`: "<a> held for approval: this step read output from ...", "<a> refused: this
// step read output from ...". Only the rule is kept; the subject after it never is.
const HARDLINE = /^Hardline rule ([^:\s]+):/;
const DENY_GLOB = /^Refused by approvals\.deny glob (.+?), which matched:/;
const FLOOR = /^Approval floor: (.+?)\. This is never auto-approvable/;
const PROVENANCE_REFUSED = /^\S+ refused: this step read output from /;
const PROVENANCE_HELD = /^\S+ held for approval: this step read output from /;
const CLASS_FLOOR = /^\S+: Class floor: /;

/** A record's gate outcome, from the dispatch chain's own result; null for anything that ran. */
export function classifyToolRecord(record: Pick<ToolCallRecord, "status" | "summary">): ToolRecordClass | null {
  if (record.status !== "blocked" && record.status !== "needs_approval") return null;
  const summary = record.summary;
  if (record.status === "needs_approval") {
    if (PROVENANCE_HELD.test(summary)) return { outcome: "hold", kind: "provenance" };
    if (CLASS_FLOOR.test(summary)) return { outcome: "hold", kind: "class_floor" };
    return { outcome: "hold", kind: "approval" };
  }
  const hardline = HARDLINE.exec(summary);
  if (hardline) return { outcome: "refusal", kind: "hardline", rule: clean(hardline[1]!) };
  const deny = DENY_GLOB.exec(summary);
  if (deny) return { outcome: "refusal", kind: "deny_glob", rule: clean(deny[1]!) };
  const floor = FLOOR.exec(summary);
  if (floor) return { outcome: "refusal", kind: "approval_floor", rule: clean(floor[1]!) };
  if (PROVENANCE_REFUSED.test(summary)) return { outcome: "refusal", kind: "provenance", rule: "untrusted_context" };
  return { outcome: "refusal", kind: "other", rule: "unclassified" };
}

/** An adapter's declared tool for this action, else the adapter's own name: never a model-chosen string. */
function toolLabel(adapter: TrentToolAdapter, action: string): string {
  const tool = toolNameOf(action);
  return tool !== "" && adapter.scopes.includes(tool) ? tool : adapter.name;
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

const counts = (map: Map<string, number>): NamedCount[] => [...map].map(([tool, calls]) => ({ tool, calls }));

export function createRunSecurityCollector(options: RunSecurityCollectorOptions): RunSecurityCollector {
  const maxHosts = options.maxHosts ?? 64;
  let egressState = options.egressState;
  let provider = options.credentialProvider;
  const hosts = new Map<string, { allowed: number; refused: number; rules: string[] }>();
  const other = { allowed: 0, refused: 0, names: new Set<string>() };
  let injected = 0;
  let withheld = 0;
  const known = new Set<string>();
  const untrusted = new Map<string, number>();
  const tools = new Map<string, number>();
  const holds = new Map<string, { kind: HoldKind; tool: string; count: number }>();
  const refusals = new Map<string, { kind: RefusalKind; rule: string; tool: string; count: number }>();

  const knowTools = (names: Iterable<string>): void => {
    for (const name of names) known.add(name.toLowerCase());
  };
  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // An observer never fails what it observes.
    }
  };

  const onRecord = (adapter: TrentToolAdapter, action: string, record: ToolCallRecord): void => {
    const tool = toolLabel(adapter, action);
    bump(tools, tool);
    const cls = classifyToolRecord(record);
    if (cls === null) return;
    if (cls.outcome === "hold") {
      const key = `${cls.kind}\n${tool}`;
      const entry = holds.get(key) ?? { kind: cls.kind, tool, count: 0 };
      entry.count += 1;
      holds.set(key, entry);
      return;
    }
    const key = `${cls.kind}\n${cls.rule}\n${tool}`;
    const entry = refusals.get(key) ?? { kind: cls.kind, rule: cls.rule, tool, count: 0 };
    entry.count += 1;
    refusals.set(key, entry);
  };

  return {
    egressDecision(decision) {
      guard(() => {
        const host = clean(decision.host || "(none)");
        const refused = decision.verdict === "refused";
        if (decision.credential === "injected") injected += 1;
        if (decision.credential === "withheld") withheld += 1;
        let tally = hosts.get(host);
        if (tally === undefined && hosts.size >= maxHosts) {
          if (other.names.size < MAX_FOLDED_NAMES) other.names.add(host);
          if (refused) other.refused += 1;
          else other.allowed += 1;
          return;
        }
        tally ??= { allowed: 0, refused: 0, rules: [] };
        hosts.set(host, tally);
        if (!refused) {
          tally.allowed += 1;
          return;
        }
        tally.refused += 1;
        const rule = clean(decision.rule ?? "unspecified");
        if (!tally.rules.includes(rule)) tally.rules.push(rule);
      });
    },
    setEgressState(state, credentialProvider) {
      egressState = state;
      provider = credentialProvider;
    },
    knowTools,
    observeLedger(ledger) {
      return {
        note(tool, provenance) {
          if (provenance === "untrusted") guard(() => bump(untrusted, known.has(tool.toLowerCase()) ? tool.toLowerCase() : UNLISTED_TOOL));
          return ledger.note(tool, provenance);
        },
        sources: () => ledger.sources(),
        isUntrusted: () => ledger.isUntrusted(),
        clear: (runId, stepId) => ledger.clear(runId, stepId),
      };
    },
    observeAdapters(adapters) {
      for (const adapter of adapters) knowTools([adapter.name, ...adapter.scopes]);
      return adapters.map((adapter) => {
        const execute: TrentToolAdapter["execute"] = async (action, payload) => {
          const record = await adapter.execute(action, payload);
          guard(() => onRecord(adapter, action, record));
          return record;
        };
        // The same Proxy shape the provenance and idempotency wrappers use: every other member is
        // read from the original on access, so a live `scopes` getter (the MCP bridge) still works.
        return new Proxy(adapter, {
          get(target, property) {
            if (property === "execute") return execute;
            return Reflect.get(target, property, target);
          },
        });
      });
    },
    snapshot() {
      const marker = options.isNetworkDerived ?? (() => (options.workspace === undefined ? false : isNetworkDerived(options.workspace)));
      let networkDerived = false;
      guard(() => {
        networkDerived = marker();
      });
      return {
        offline: options.offline,
        backend: options.backend,
        egress: {
          state: egressState,
          hosts: [...hosts].map(([host, t]) => ({ host, allowed: t.allowed, refused: t.refused, rules: [...t.rules] })),
          otherHosts: { allowed: other.allowed, refused: other.refused, count: other.names.size },
        },
        credentials: provider === undefined ? [] : [{ provider: clean(provider), injected, withheld }],
        untrusted: counts(untrusted),
        networkDerivedWorkspace: networkDerived,
        tools: counts(tools),
        holds: [...holds.values()].map((h) => ({ ...h })),
        refusals: [...refusals.values()].map((r) => ({ ...r })),
      };
    },
  };
}
