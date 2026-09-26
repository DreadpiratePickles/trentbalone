/**
 * The policy hook at the same dispatch point as `idempotent-dispatch.ts`, wrapped OUTSIDE it so
 * a rule is evaluated before any idempotency lookup and a denied call never touches the store.
 *
 * Every call is classified (`policy-rules.ts` classifyCall) and appended to the history ring of
 * its run (`tool-call-context.ts`); outside a seat turn a process-wide ring is used so the REPL
 * gets the same protection. The request is what is recorded, not the outcome: a `read_file`
 * of `.env` that file_ops refuses still counts as a secret access, because the intent to send
 * what was just asked for is exactly what the rules are watching.
 *
 * How a hit is surfaced follows the approval floor (`tools/approval-floors.ts`), never a throw:
 *   - `deny` returns a `blocked` record from `execute` naming the rule, whatever the approval state.
 *   - `require_approval` goes through the app's own gate: `requiresApproval` answers true and
 *     `dryRun` returns the `needs_approval` record; the guardrail executor calls `execute` only
 *     once a human has said yes (`external-action-guardrails.ts`), so `execute` lets it run.
 */
import { record } from "../tools/action.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { toolNameOf } from "./idempotent-dispatch.js";
import { classifyCall, DEFAULT_POLICY_RULES, mergeRules, PolicyEvaluator, type ClassifiableCall, type PolicyCall, type PolicyClass, type PolicyDecision, type PolicyRule } from "./policy-rules.js";
import { currentSessionTaint } from "./provenance.js"; // [S1.1]
import { currentToolCallContext } from "./tool-call-context.js";

const PROCESS_RING = "process";
/** Rings for runs that have gone quiet are dropped once this many are held. */
const MAX_RINGS = 256;

function argsOf(action: string): unknown {
  const trimmed = action.trim();
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex === -1) return trimmed;
  try {
    return JSON.parse(trimmed.slice(braceIndex)) as unknown;
  } catch {
    return trimmed;
  }
}

export class PolicyDispatcher {
  readonly evaluator: PolicyEvaluator;
  private readonly rings = new Map<string, PolicyCall[]>();

  constructor(defaults: readonly PolicyRule[] = DEFAULT_POLICY_RULES, configured: readonly PolicyRule[] = []) {
    this.evaluator = new PolicyEvaluator(mergeRules(defaults, configured));
  }

  private ringKey(): string {
    return currentToolCallContext()?.runId ?? PROCESS_RING;
  }

  /** The recorded calls of the current run (or the process ring), oldest first. */
  history(): readonly PolicyCall[] {
    // [S1.1] A run bound to a session reads its conversation's ring (`provenance.ts` SessionTaint).
    return currentSessionTaint()?.calls ?? this.rings.get(this.ringKey()) ?? [];
  }

  /** Appends a call to the current ring, keeping only what the longest rule window needs. */
  remember(call: ClassifiableCall): PolicyClass[] {
    return this.rememberEntry(call).classes;
  }

  private rememberEntry(call: ClassifiableCall): { tool: string; classes: PolicyClass[]; at: number } {
    const entry = { tool: call.tool || call.adapter, classes: classifyCall(call), at: Date.now() };
    const key = this.ringKey();
    // [S1.1] A session-bound run appends to its conversation's ring, which outlives the run.
    let ring: PolicyCall[] | undefined = currentSessionTaint()?.calls ?? this.rings.get(key);
    if (ring === undefined) {
      if (this.rings.size >= MAX_RINGS) this.rings.delete(this.rings.keys().next().value as string);
      ring = [];
      this.rings.set(key, ring);
    }
    ring.push(entry);
    if (ring.length > this.evaluator.window) ring.splice(0, ring.length - this.evaluator.window);
    return entry;
  }

  /** The decision for `call` against the current ring, without recording it. */
  decide(call: ClassifiableCall): PolicyDecision | undefined {
    return this.evaluator.evaluate(classifyCall(call), this.history());
  }

  private callOf(adapter: TrentToolAdapter, action: string): ClassifiableCall {
    return { adapter: adapter.name, scopes: adapter.scopes, tool: toolNameOf(action), args: argsOf(action) };
  }

  /** Wraps each adapter so every `execute` is evaluated against, then recorded in, the run's history. */
  wrap(adapters: readonly TrentToolAdapter[]): TrentToolAdapter[] {
    return adapters.map((adapter) => {
      const requiresApproval = (action: string): boolean => this.decide(this.callOf(adapter, action))?.effect === "require_approval" || adapter.requiresApproval(action);
      const dryRun = async (action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> => {
        const decision = this.decide(this.callOf(adapter, action));
        if (decision?.effect === "require_approval") return record(adapter.name, action, "needs_approval", describe(decision, "needs approval before it runs"));
        if (adapter.dryRun) return adapter.dryRun(action, payload);
        return record(adapter.name, action, "needs_approval", `${adapter.name} action requires approval before execution.`);
      };
      const execute = async (action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> => {
        const call = this.callOf(adapter, action);
        const decision = this.decide(call);
        const entry = this.rememberEntry(call);
        if (decision?.effect === "deny") return record(adapter.name, action, "blocked", describe(decision, "is blocked, whatever the approval state"));
        const result = await adapter.execute(action, payload);
        // [U1] A result the adapter itself tagged untrusted — a delegated child that read a page,
        // an executor tagging one inbox message — is an inbound read for the rules that follow it.
        if (result.provenance === "untrusted" && !entry.classes.includes("inbound")) entry.classes.push("inbound");
        return result;
      };
      return new Proxy(adapter, {
        get(target, property) {
          if (property === "execute") return execute;
          if (property === "requiresApproval") return requiresApproval;
          if (property === "dryRun") return dryRun;
          return Reflect.get(target, property, target);
        },
      });
    });
  }
}

function describe(decision: PolicyDecision, verb: string): string {
  const { rule } = decision;
  const read = decision.trigger === undefined ? "" : ` (${decision.trigger.tool})`;
  const trigger = rule.after === undefined ? `a ${rule.when} call` : `a ${rule.when} call within ${rule.within} calls of a ${rule.after} call${read}`;
  return `Policy rule ${rule.id}: ${trigger} ${verb}. ${rule.reason}.`;
}
