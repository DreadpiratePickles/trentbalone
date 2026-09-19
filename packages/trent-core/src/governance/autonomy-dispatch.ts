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
 *   4. pre_tool_call hooks  -> blocked when one exits non-zero, with its stderr as the reason
 *   5. the adapter
 *   6. post_tool_call hooks -> logged, never blocking; the adapter's record is returned unchanged
 */
import { record } from "../tools/action.js";
import { floorBlock } from "../tools/approval-floors.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import type { HookToolCall, ToolHookPort } from "../hooks/types.js";
import { autonomyVerdict, isPureRead, type AutonomyLevel, type AutonomyVerdict } from "./autonomy.js";
import { denyMatch } from "./deny-globs.js";
import { hardlineBlock, type HardlineContext, type HardlineSubject } from "./hardline.js";
import { toolNameOf } from "./idempotent-dispatch.js";
import { currentToolCallContext } from "./tool-call-context.js";

export interface AutonomyDispatchOptions {
  readonly level: AutonomyLevel;
  readonly deny: readonly string[];
  readonly hardline: HardlineContext;
  readonly hooks?: ToolHookPort;
  /** Named on a hook payload so a hook can tell which seat asked. */
  readonly seat?: string;
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

function verdictFor(action: string, adapterAsks: boolean, adapter: TrentToolAdapter, options: AutonomyDispatchOptions): AutonomyVerdict {
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
    pureRead: isPureRead({ adapter: adapter.name, scopes: adapter.scopes, tool: toolNameOf(action), args: argsOf(action) ?? action }),
  });
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
  return adapters.map((adapter) => {
    const requiresApproval = (action: string): boolean => {
      // A refusal must reach `execute` to be reported as `blocked` with its reason, so it never
      // claims to need an approval nobody can usefully give.
      return verdictFor(action, adapter.requiresApproval(action), adapter, options).outcome === "ask";
    };

    const dryRun = async (action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> => {
      const verdict = verdictFor(action, adapter.requiresApproval(action), adapter, options);
      if (verdict.outcome === "ask" && !adapter.requiresApproval(action)) {
        return record(adapter.name, action, "needs_approval", `${adapter.name}: ${verdict.reason}.`);
      }
      if (adapter.dryRun) return adapter.dryRun(action, payload);
      return record(adapter.name, action, "needs_approval", `${adapter.name} action requires approval before execution.`);
    };

    const execute = async (action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> => {
      const verdict = verdictFor(action, adapter.requiresApproval(action), adapter, options);
      if (verdict.outcome === "refuse") return record(adapter.name, action, "blocked", verdict.reason);

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
