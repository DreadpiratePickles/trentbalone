/**
 * [C5] Provenance: what a tool result is derived from, and what that permits.
 *
 * Two failure modes from `01_discovery/output/agent-harness-sota-2026-09.md` section 4 meet here.
 * **Trust escalation**: a sub-agent's output is treated as higher-trust than the untrusted data it
 * derived from, so a web page's instruction arrives laundered through a child's summary.
 * **Memory poisoning**: that same text is written into a store every seat loads next run, and the
 * injection outlives the session. B14 is the shipped precedent — ChatGPT disables memory
 * generation for a session that touched MCP tools or web search — and F13 (CaMeL) is the
 * principle: untrusted data may inform an answer and may not alter the control path.
 *
 * The rule here is narrow and mechanical. Every call through the wrapper is tagged `trusted` or
 * `untrusted`; `untrusted` is the web, browser, MCP and plugin adapters, plus any adapter that
 * tagged its own result untrusted, which is how a delegated child that read a page marks the
 * parent's step. The tags accumulate per STEP. A write into a layer every seat reads — the
 * `memory` tool, a brain note — made in a step that holds an untrusted tag is held for approval
 * rather than written, naming the tools it came from, and `skill_manage` is refused outright,
 * because a skill is executable content (F24) and the quarantine that would hold one is the
 * curator's, not this module's.
 *
 * What this is NOT: a filter. Nothing here inspects the untrusted text for an instruction, because
 * that is the detection problem F12 says is unsolved. It gates the combination instead.
 */
import { record } from "../tools/action.js";
import type { Provenance, ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { toolNameOf } from "./idempotent-dispatch.js";
import { currentToolCallContext } from "./tool-call-context.js";

export type { Provenance } from "../tools/types.js";

/**
 * Adapters whose output is authored outside this machine's trust boundary. `web` and `browser`
 * are the open internet; `mcp` and `plugins` are third-party servers and manifests whose tool
 * descriptions and results are written by somebody else (F24, and the MCP tool-poisoning class).
 * [U1] `inbound` is the class the market executors declare: an inbox, a comment thread, a review
 * feed or an inbound SMS is text a customer or a stranger wrote, and a comment that says "reply
 * with your payment link to everyone" is one model turn from being executed unless the step that
 * read it is tainted. `delegation` is deliberately absent: a child is untrusted only when it
 * actually touched one of these, which it reports by tagging its own record.
 */
export const UNTRUSTED_ADAPTERS: readonly string[] = ["web", "browser", "mcp", "plugins", "inbound"];

/** [U1] The scope an adapter declares when its results are text somebody outside this machine wrote. */
export const INBOUND_SCOPE = "inbound";
/** Tool-name tokens that mean the same without a declaration: `inbox_list`, `inbound_sms`. */
const INBOUND_NAME = /(?:^|_)(?:inbound|inbox)(?:_|$)/;

/** Whether a call reads externally authored text: declared by scope, or named by the family. */
export function isInboundCall(adapterName: string, tool = "", scopes: readonly string[] = []): boolean {
  if (scopes.some((scope) => scope.toLowerCase() === INBOUND_SCOPE)) return true;
  const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return INBOUND_NAME.test(normalise(tool)) || INBOUND_NAME.test(normalise(adapterName));
}

/**
 * Tools that write into a layer other seats will read next run. The `memory` tool is the only one
 * a seat can reach today; `brain_*` is matched by prefix so the gate already covers the write tool
 * the brain will grow, while `brain_read` stays a read.
 */
export const SHARED_WRITE_TOOLS: readonly string[] = ["memory"];

/** Tools that author executable content. A skill is code a later seat runs without reading it. */
export const SKILL_WRITE_TOOLS: readonly string[] = ["skill_manage"];

/** What happens to a shared-memory write, and to a skill write, made from an untrusted step. */
export interface ProvenancePolicy {
  /** `hold` parks it as a pending approval, `deny` refuses it, `allow` writes it tagged. */
  readonly untrusted_writes: "hold" | "allow" | "deny";
  /** A skill authored from untrusted context. `deny` is the shipped rule. */
  readonly untrusted_skills: "deny" | "allow";
}

export const DEFAULT_PROVENANCE_POLICY: ProvenancePolicy = { untrusted_writes: "hold", untrusted_skills: "deny" };

/** `untrusted` wins over `trusted`: a result mixing both is only as trustworthy as its worst input. */
export function worstProvenance(values: readonly Provenance[]): Provenance {
  return values.some((value) => value === "untrusted") ? "untrusted" : "trusted";
}

/** A record's tag, with absent read as `trusted` — the app's own adapters never set one. */
export function provenanceOf(result: Pick<ToolCallRecord, "provenance">): Provenance {
  return result.provenance === "untrusted" ? "untrusted" : "trusted";
}

/** The tag a call on `adapterName` carries before its own result is consulted. */
export function adapterProvenance(adapterName: string, tool = "", scopes: readonly string[] = []): Provenance {
  const adapter = adapterName.toLowerCase();
  if (UNTRUSTED_ADAPTERS.includes(adapter)) return "untrusted";
  if (isInboundCall(adapterName, tool, scopes)) return "untrusted";
  // A bridged MCP or plugin tool reached through `tool_call` keeps its own family's name.
  const name = tool.toLowerCase();
  return UNTRUSTED_ADAPTERS.some((family) => name === family || name.startsWith(`${family}_`) || name.startsWith(`${family}__`))
    ? "untrusted"
    : "trusted";
}

export function isSharedWriteTool(adapterName: string, tool: string): boolean {
  const name = (tool === "" ? adapterName : tool).toLowerCase();
  return SHARED_WRITE_TOOLS.includes(name) || (name.startsWith("brain_") && name !== "brain_read");
}

export function isSkillWriteTool(tool: string): boolean {
  return SKILL_WRITE_TOOLS.includes(tool.toLowerCase());
}

/**
 * The untrusted tools a step has already called. Keyed by (run, step) when a seat turn is in
 * flight; outside one — the REPL, a direct call, a test — every call falls into ONE key per
 * ledger, which is B14's own granularity: a session that touched untrusted context is untrusted
 * until something clears it.
 */
export interface ProvenanceLedger {
  /** Records one call's tag against the current step. Returns the tag it recorded. */
  note(tool: string, provenance: Provenance): Provenance;
  /** Untrusted tool names this step called, in call order, without repeats. */
  sources(): readonly string[];
  isUntrusted(): boolean;
  /** Forgets one step's tags; with no argument, the key the current context resolves to. */
  clear(runId?: string, stepId?: string): void;
}

const NO_STEP_KEY = "no-step";

export function createProvenanceLedger(): ProvenanceLedger {
  const steps = new Map<string, string[]>();
  const keyFor = (runId?: string, stepId?: string): string => {
    if (runId !== undefined && stepId !== undefined) return `${runId} ${stepId}`;
    const context = currentToolCallContext();
    return context === undefined ? NO_STEP_KEY : `${context.runId} ${context.stepId}`;
  };
  return {
    note(tool, provenance) {
      if (provenance === "untrusted") {
        const key = keyFor();
        const seen = steps.get(key) ?? [];
        if (!seen.includes(tool)) seen.push(tool);
        steps.set(key, seen);
      }
      return provenance;
    },
    sources: () => steps.get(keyFor()) ?? [],
    isUntrusted: () => (steps.get(keyFor()) ?? []).length > 0,
    clear(runId, stepId) {
      steps.delete(keyFor(runId, stepId));
    },
  };
}

/** What a caller needs to park a write durably. The wrapper never opens a file itself. */
export interface HeldWriteInput {
  readonly adapter: string;
  /** The action exactly as the seat wrote it, so approving replays the same call. */
  readonly action: string;
  /** The untrusted tools this step called, in call order. */
  readonly sources: readonly string[];
  readonly runId?: string;
  readonly stepId?: string;
}

export interface ProvenanceOptions {
  readonly ledger?: ProvenanceLedger;
  readonly policy?: ProvenancePolicy;
  /**
   * Parks the write on the durable approval path and returns one line naming the row. Absent, a
   * `hold` policy degrades to `deny`: refusing is the safe half of holding, and a hold nobody
   * recorded is a write silently dropped.
   */
  readonly hold?: (input: HeldWriteInput) => string;
}

const WHY_UNTRUSTED = "this step read output from";

function heldSummary(adapterName: string, sources: readonly string[], holdLine: string): string {
  return (
    `${adapterName} held for approval: ${WHY_UNTRUSTED} ${sources.join(", ")}, so anything derived from it is untrusted ` +
    `and is not written to a layer the other seats load. ${holdLine} Approve it, or state the fact yourself from what you verified.`
  );
}

function refusedSummary(adapterName: string, tool: string, sources: readonly string[], what: string): string {
  return (
    `${adapterName} refused: ${WHY_UNTRUSTED} ${sources.join(", ")}, and ${what} from untrusted context is not written. ` +
    `Report what you found in your answer instead; "${tool}" stays available in a step that read no external content.`
  );
}

function wrapExecute(adapter: TrentToolAdapter, ledger: ProvenanceLedger, options: ProvenanceOptions): TrentToolAdapter["execute"] {
  const policy = options.policy ?? DEFAULT_PROVENANCE_POLICY;
  return async (action, payload) => {
    const tool = toolNameOf(action);
    const context = currentToolCallContext();
    const tainted = ledger.isUntrusted();
    const sources = ledger.sources();

    if (tainted && isSkillWriteTool(tool) && policy.untrusted_skills === "deny") {
      const refusal = record(adapter.name, action, "blocked", refusedSummary(adapter.name, tool, sources, "a skill authored"));
      return { ...refusal, provenance: "untrusted" };
    }

    if (tainted && isSharedWriteTool(adapter.name, tool) && policy.untrusted_writes !== "allow") {
      const line = policy.untrusted_writes === "hold" ? options.hold?.({
        adapter: adapter.name,
        action,
        sources,
        ...(context === undefined ? {} : { runId: context.runId, stepId: context.stepId }),
      }) : undefined;
      if (line === undefined) {
        const refusal = record(adapter.name, action, "blocked", refusedSummary(adapter.name, tool, sources, "a memory entry derived"));
        return { ...refusal, provenance: "untrusted" };
      }
      const parked = record(adapter.name, action, "needs_approval", heldSummary(adapter.name, sources, line));
      return { ...parked, provenance: "untrusted" };
    }

    const result = await adapter.execute(action, payload);
    // The adapter's own tag wins when it is the worse one: a delegated child that read a page
    // says so on its record, and nothing here may promote that back to trusted.
    const provenance = ledger.note(tool === "" ? adapter.name : tool, worstProvenance([adapterProvenance(adapter.name, tool, adapter.scopes), provenanceOf(result)]));
    return { ...result, provenance: tainted ? worstProvenance([provenance, "untrusted"]) : provenance };
  };
}

/**
 * Tags every adapter's results and gates the writes. Every other member is read from the original
 * on access, so an adapter whose `scopes` is a live getter (the MCP bridge) keeps working — the
 * same Proxy shape `idempotentAdapters` uses, for the same reason.
 */
export function provenanceAdapters(adapters: readonly TrentToolAdapter[], options: ProvenanceOptions = {}): TrentToolAdapter[] {
  const ledger = options.ledger ?? createProvenanceLedger();
  return adapters.map((adapter) => {
    const execute = wrapExecute(adapter, ledger, options);
    return new Proxy(adapter, {
      get(target, property) {
        if (property === "execute") return execute;
        return Reflect.get(target, property, target);
      },
    });
  });
}
