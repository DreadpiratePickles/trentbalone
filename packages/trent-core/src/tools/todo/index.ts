/**
 * A3 — `todo`: the per-run task list Hermes has (`todo` toolset) and Trent did not.
 *
 * It exists for one measured reason: MAST's failure taxonomy puts "step repetition" and "loss of
 * task state" among the common multi-agent failures, and a seat with no written plan re-derives one
 * every turn from a transcript that compaction is actively shortening. The list is the one piece of
 * turn state that must NOT be summarised away, so it lives outside the transcript
 * (`./store.ts` says why on disk rather than on the run record).
 *
 * No surface work here: {@link TodoAdapter.items} is the getter a REPL pane or the TUI renders from.
 *
 * // [C12] A solo conversation's list is ITS list, not one message's: a call bound to a conversation (the binding the
 * memory tool's owner check reads, `governance/provenance.ts` `currentSessionTaint`) files under the conversation's
 * key, so a plan written in turn 1 is still there in turn 3 and after a compaction. A call bound to none (every
 * fleet seat's) keeps the per-run list.
 */
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import { currentSessionTaint } from "../../governance/provenance.js"; // [C12] the conversation a solo call is bound to
import { parseAction, record as toRecord, type ToolSpec } from "../action.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import { isTodoStatus, TODO_STATUSES, TodoStore, type TodoItem, type TodoStatus } from "./store.js";

export { TodoStore, TODO_STATUSES, MAX_ITEMS_PER_RUN, isTodoStatus, type TodoItem, type TodoStatus } from "./store.js";

export const TODO_ADAPTER_NAME = "todo";
export const TODO_SCOPES = ["todo"];
/** Outside a run — a direct REPL call, a test — the list is keyed here rather than refused. */
export const TODO_LOCAL_RUN = "local";
/** [C12] Where a solo conversation's list is filed: its key, apart from every run id. */
export const todoConversationKey = (conversation: string): string => `conversation:${conversation}`; // [C12]

/** [C12] What a list belongs to, as the model is told it. */
type TodoScope = "run" | "conversation"; // [C12]

const SPECS: readonly ToolSpec[] = [{ name: TODO_ADAPTER_NAME, primary: "action", signature: ["action"] }];
const ROUTING_TEXT =
  "task list, plan the steps, track what is done, mark a step in progress, what is left to do, " +
  "check off a task, record a blocker on a step";

export const TODO_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: TODO_ADAPTER_NAME,
    description:
      "Your task list for this run. Write the plan down with add before you start, move one item to " +
      "doing at a time, and close it with done or blocked before the next. The list survives " +
      "compaction and a restart, so it is what you read back rather than re-reading the transcript.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "update", "list"], description: "What to do with the list." },
        items: { type: "array", items: { type: "string" }, description: "For add: one line per task, in the order you intend to do them." },
        id: { type: "string", description: "For update: the id list printed, such as t1." },
        status: { type: "string", enum: [...TODO_STATUSES], description: "For update: the new status." },
        text: { type: "string", description: "For update: a corrected description of the task." },
        note: { type: "string", description: "For update: why it is blocked, or what done produced." },
      },
      required: ["action"],
    },
  },
];

export interface TodoAdapterOptions {
  readonly profileDir: string;
  /** Injected so a test can pin the timestamps; defaults to the wall clock. */
  readonly now?: () => string;
}

export interface TodoAdapter extends TrentToolAdapter {
  /** The current list for a run, for a surface to render. Defaults to the run in scope. */
  items(runId?: string): readonly TodoItem[];
}

function renderList(items: readonly TodoItem[], scope: TodoScope = "run"): string { // [C12] scope
  if (items.length === 0) return `the task list for this ${scope} is empty; add the steps you intend to take.`; // [C12]
  const counts = new Map<TodoStatus, number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const header = TODO_STATUSES.filter((status) => counts.has(status)).map((status) => `${counts.get(status)} ${status}`).join(", ");
  const lines = items.map((item) => `${item.id} [${item.status}] ${item.text}${item.note === undefined ? "" : ` (${item.note})`}`);
  return [`tasks: ${header}`, ...lines].join("\n");
}

function textsOf(args: Record<string, unknown>): string[] {
  const raw = Array.isArray(args.items) ? args.items : args.text !== undefined ? [args.text] : [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export function createTodoAdapter(options: TodoAdapterOptions): TodoAdapter {
  const store = new TodoStore(options.profileDir);
  const now = options.now ?? ((): string => new Date().toISOString());
  const runOf = (): string => currentToolCallContext()?.runId ?? TODO_LOCAL_RUN;
  // [C12] The conversation's list when the call is bound to one, else the run's.
  const listOf = (): { readonly key: string; readonly scope: TodoScope } => { // [C12]
    const conversation = currentSessionTaint()?.key;
    return conversation === undefined ? { key: runOf(), scope: "run" } : { key: todoConversationKey(conversation), scope: "conversation" };
  };
  const record = (action: string, status: ToolCallRecord["status"], summary: string): ToolCallRecord =>
    toRecord(TODO_ADAPTER_NAME, action, status, summary);

  return {
    name: TODO_ADAPTER_NAME,
    scopes: [...TODO_SCOPES],
    availability: "real",
    instructions: renderToolInstructions(TODO_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    /** Bookkeeping inside the profile. It touches nothing outside, so it never asks a human. */
    requiresApproval: () => false,
    async execute(action) {
      const { args, error } = parseAction(action, SPECS);
      if (error) return record(action, "failed", error);
      const { key: runId, scope } = listOf(); // [C12]
      const verb = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";

      if (verb === "list") return record(action, "completed", renderList(store.list(runId), scope)); // [C12] scope

      if (verb === "add") {
        const texts = textsOf(args);
        if (texts.length === 0) return record(action, "failed", 'todo add needs "items": one non-empty string per task.');
        const added = store.add(runId, texts, now());
        if (added.length === 0) return record(action, "failed", `todo add wrote nothing: this ${scope} is already at its task limit.`); // [C12]
        return record(action, "completed", renderList(store.list(runId), scope)); // [C12]
      }

      if (verb === "update") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (id === "") return record(action, "failed", 'todo update needs the "id" the list printed, such as t1.');
        if (args.status !== undefined && !isTodoStatus(args.status)) {
          return record(action, "failed", `todo update: "${String(args.status)}" is not a status. Use one of: ${TODO_STATUSES.join(", ")}.`);
        }
        const patch: { status?: TodoStatus; text?: string; note?: string } = {};
        if (isTodoStatus(args.status)) patch.status = args.status;
        if (typeof args.text === "string") patch.text = args.text;
        if (typeof args.note === "string") patch.note = args.note;
        const updated = store.update(runId, id, patch, now());
        if (updated === undefined) return record(action, "failed", `todo update: this ${scope} has no task "${id}". Call todo with action list to see the ids.`); // [C12]
        return record(action, "completed", renderList(store.list(runId), scope)); // [C12]
      }

      return record(action, "failed", `todo: "${verb}" is not an action. Use add, update or list.`);
    },
    items(runId) {
      return store.list(runId ?? listOf().key); // [C12] the conversation's list when bound
    },
    async cleanup() {},
  };
}
