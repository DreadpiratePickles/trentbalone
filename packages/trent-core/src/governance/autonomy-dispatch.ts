/**
 * The autonomy, hardline, deny-glob and hook wrapper at the tool dispatch seam.
 *
 * `tools/index.ts` wraps every adapter with this FIRST, so the policy dispatcher and the
 * idempotency store sit inside it: a hardline refusal never reaches the idempotency store, never
 * enters the policy ring, and never reaches the adapter. It is applied on `execute`, not only on
 * `requiresApproval`, for the same reason `floorBlock` is (`tools/approval-floors.ts`): the seat
 * loop grants approval for the whole remaining loop once a human says yes
 * (`seat-agent-loop.ts:209`), so a second call in the same step must still hit the floor.
 *
 * Order inside one call:
 *   1. hardline blocklist   -> blocked, at every level
 *   2. approvals.deny       -> blocked, at every level
 *   3. approval floor       -> blocked, at every level
 *   4. class floor [U1]     -> needs_approval at every level unless an approval is bound to
 *                              exactly this call (`bound-approvals.ts`); `dryRun` is where the
 *                              preview is put in front of the human and the row is stamped
 *   5. pre_tool_call hooks  -> blocked when one exits non-zero, with its stderr as the reason
 *   6. the adapter
 *   7. post_tool_call hooks -> logged, never blocking; the adapter's record is returned unchanged
 */
import { record } from "../tools/action.js";
import { floorBlock } from "../tools/approval-floors.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import type { HookToolCall, ToolHookPort } from "../hooks/types.js";
import { autonomyVerdict, classFloorOf, isPureRead, type AutonomyLevel, type AutonomyVerdict } from "./autonomy.js";
import { createBoundApprovalStore, type BoundApprovalStore, type BoundCall } from "./bound-approvals.js";
import { denyMatch } from "./deny-globs.js";
import { CLASS_FLOOR } from "./gate-config-schema.js";
import { hardlineBlock, type HardlineContext, type HardlineSubject } from "./hardline.js";
import { toolNameOf } from "./idempotent-dispatch.js";
import type { ClassifiableCall, PolicyClass } from "./policy-rules.js";
import { currentToolCallContext } from "./tool-call-context.js";

export interface AutonomyDispatchOptions {
  readonly level: AutonomyLevel;
  readonly deny: readonly string[];
  readonly hardline: HardlineContext;
  readonly hooks?: ToolHookPort;
  /** Named on a hook payload so a hook can tell which seat asked. */
  readonly seat?: string;
  /**
   * [U1] The class floor: a call carrying one of these classes asks at every level and runs only
   * against an approval bound to exactly that call. Absent means the shipped `CLASS_FLOOR`
   * (`gate-config-schema.ts` floorClasses adds the profile's `gate.ask_classes`).
   */
  readonly floor?: readonly PolicyClass[];
  /** Where the bound rows live. Absent means `<hardline.profileDir>/gateway.json`. */
  readonly bindings?: BoundApprovalStore;
}

/** Argument keys whose value is a command a shell would run, rather than data. */
const COMMAND_KEYS = /^(?:command|cmd|script|code|shell)$/i;
/** Tool names that read rather than write, for deciding which way a path subject is being touched. */
const READ_TOOL = /^(?:read|get|list|view|search|cat|show|describe|inspect|lookup|fetch|find|grep|head|tail)(?:_|$)/i;
const MAX_STRING_DEPTH = 4;

function argsOf(action: string): unknown {
  const trimmed = action.trim();
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex === -1) return undefined;
  try {
    return JSON.parse(trimmed.slice(braceIndex)) as unknown;
  } catch {
    return undefined;
  }
}

/** Every `key -> string` pair in the argument bag, flattened, so a nested path is still seen. */
function stringEntries(value: unknown, depth: number, out: Array<[string, string]>): void {
  if (depth > MAX_STRING_DEPTH || value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out.push([key, item]);
    else if (Array.isArray(item)) {
      for (const entry of item) {
        if (typeof entry === "string") out.push([key, entry]);
        else stringEntries(entry, depth + 1, out);
      }
    } else stringEntries(item, depth + 1, out);
  }
}

/**
 * What the floor is shown for one call: the raw action string as a command (so a command that
 * arrived under an unexpected key is still scanned), plus every string argument as both a
 * command and a path. Checking a string both ways is deliberate — `cat ~/.ssh/id_rsa` is a
 * command that names a path, and only the path rules can tell what it names.
 */
export function subjectsOfAction(action: string): HardlineSubject[] {
  const tool = toolNameOf(action);
  const access: "read" | "write" = READ_TOOL.test(tool) ? "read" : "write";
  const subjects: HardlineSubject[] = [{ kind: "command", value: action }];
  const entries: Array<[string, string]> = [];
  stringEntries(argsOf(action), 0, entries);
  for (const [key, value] of entries) {
    if (value === "") continue;
    subjects.push({ kind: "command", value });
    if (!COMMAND_KEYS.test(key)) subjects.push({ kind: "path", value, access });
  }
  return subjects;
}

/** The command strings of a call, for `floorBlock`, which only understands commands. */
function commandsOf(action: string, subjects: readonly HardlineSubject[]): string[] {
  const out = new Set<string>([action]);
  for (const subject of subjects) if (subject.kind === "command") out.add(subject.value);
  return [...out];
}

function classifiable(adapter: TrentToolAdapter, action: string): ClassifiableCall {
  return { adapter: adapter.name, scopes: adapter.scopes, tool: toolNameOf(action), args: argsOf(action) ?? action };
}

function verdictFor(action: string, adapterAsks: boolean, adapter: TrentToolAdapter, options: AutonomyDispatchOptions, classFloor: readonly PolicyClass[]): AutonomyVerdict {
  const subjects = subjectsOfAction(action);
  const hardline = hardlineBlock(subjects, options.hardline);
  const deny = hardline === null && options.deny.length > 0 ? denyMatch(options.deny, subjects.map((s) => s.value), options.hardline.home) : null;
  const floor = hardline === null && deny === null ? (commandsOf(action, subjects).map((command) => floorBlock(command)).find((hit) => hit !== null) ?? null) : null;
  return autonomyVerdict({
    level: options.level,
    hardline,
    deny,
    floor,
    adapterAsks,
    pureRead: isPureRead(classifiable(adapter, action)),
    classFloor,
  });
}

/** [U1] The call as the binding keys it: the adapter-qualified tool and the parsed arguments, inside the current step. */
function boundCallOf(adapter: TrentToolAdapter, action: string, call: ClassifiableCall, classes: readonly PolicyClass[], seat?: string): BoundCall {
  const context = currentToolCallContext();
  return {
    adapter: adapter.name,
    action,
    // The raw `<tool>` head, empty for a bare JSON action, so the key is the idempotency key exactly.
    tool: call.tool,
    args: call.args,
    classes,
    ...(context === undefined ? {} : { runId: context.runId, stepId: context.stepId }),
    ...(seat === undefined ? {} : { seat }),
  };
}

/** What the human is shown: the adapter's own rendering when it has one, else the arguments as written. */
function previewOf(adapter: TrentToolAdapter, action: string, call: ClassifiableCall): string {
  const own = adapter.preview?.(action);
  if (own !== undefined && own.trim() !== "") return own;
  return typeof call.args === "string" ? call.args : JSON.stringify(call.args);
}

function hookCall(adapter: TrentToolAdapter, action: string, seat?: string): HookToolCall {
  const context = currentToolCallContext();
  return {
    adapter: adapter.name,
    tool: toolNameOf(action) || adapter.name,
    args: argsOf(action) ?? action,
    ...(context === undefined ? {} : { runId: context.runId, stepId: context.stepId }),
    ...(seat === undefined ? {} : { seat }),
  };
}

/**
 * Wraps each adapter so every call is measured against the floor, the level and the hooks. The
 * Proxy mirrors `policy-dispatch.ts`: the adapter object keeps its identity and its other fields,
 * and only the three dispatch members are replaced.
 */
export function autonomyAdapters(adapters: readonly TrentToolAdapter[], options: AutonomyDispatchOptions): TrentToolAdapter[] {
  const floor = options.floor ?? CLASS_FLOOR;
  const bindings = options.bindings ?? createBoundApprovalStore({ profileDir: options.hardline.profileDir });
  return adapters.map((adapter) => {
    const requiresApproval = (action: string): boolean => {
      // A refusal must reach `execute` to be reported as `blocked` with its reason, so it never
      // claims to need an approval nobody can usefully give.
      return verdictFor(action, adapter.requiresApproval(action), adapter, options, classFloorOf(classifiable(adapter, action), floor)).outcome === "ask";
    };

    const dryRun = async (action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> => {
      const call = classifiable(adapter, action);
      const floored = classFloorOf(call, floor);
      const verdict = verdictFor(action, adapter.requiresApproval(action), adapter, options, floored);
      if (verdict.outcome === "ask" && floored.length > 0) {
        // The pause. What is stored here is what the human is shown, and only a call with this
        // exact key is granted on the replay. An inner gate (a policy rule, the adapter's own
        // floor) adds its reason so the card says everything that is being asked.
        const row = bindings.preview(boundCallOf(adapter, action, call, floored, options.seat), previewOf(adapter, action, call));
        const inner = adapter.requiresApproval(action) && adapter.dryRun ? await adapter.dryRun(action, payload) : undefined;
        const why = inner?.status === "needs_approval" ? ` ${inner.summary}` : "";
        return record(adapter.name, action, "needs_approval", `${adapter.name}: ${verdict.reason}. Approval ${row.id} covers exactly this call: ${row.details.preview}.${why}`);
      }
      if (verdict.outcome === "ask" && !adapter.requiresApproval(action)) {
        return record(adapter.name, action, "needs_approval", `${adapter.name}: ${verdict.reason}.`);
      }
      if (adapter.dryRun) return adapter.dryRun(action, payload);
      return record(adapter.name, action, "needs_approval", `${adapter.name} action requires approval before execution.`);
    };

    const execute = async (action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> => {
      const classified = classifiable(adapter, action);
      const floored = classFloorOf(classified, floor);
      const verdict = verdictFor(action, adapter.requiresApproval(action), adapter, options, floored);
      if (verdict.outcome === "refuse") return record(adapter.name, action, "blocked", verdict.reason);
      if (floored.length > 0) {
        // Inside `execute`, not only at `requiresApproval`: the loop-wide grant the seat loop
        // holds after one yes does not reach a call whose key no human has seen.
        const grant = bindings.require(boundCallOf(adapter, action, classified, floored, options.seat), previewOf(adapter, action, classified));
        if (!grant.granted) return grant.record;
      }

      const call = hookCall(adapter, action, options.seat);
      if (options.hooks) {
        const gate = await options.hooks.pre(call);
        if (gate.blocked) return record(adapter.name, action, "blocked", gate.reason);
      }
      const result = await adapter.execute(action, payload);
      if (options.hooks) await options.hooks.post(call, { status: result.status, summary: result.summary });
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
