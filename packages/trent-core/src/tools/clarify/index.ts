/**
 * A3 — `clarify`: up to five independent questions in ONE founder card.
 *
 * `ask_human` already parks a step for a decision. What it cannot do is ask five things at once,
 * and asking them one at a time costs five round trips through a human — the interruption, not the
 * token, is the expensive part. Hermes's `clarify` batches them (inventory §1.4); this is that,
 * on Trent's existing parking path and no other.
 *
 * The path is `tools/human/`'s, unchanged: `requiresApproval` answers true, the guardrail executor
 * calls `dryRun`, the `needs_approval` record carries `details: {kind: "questions", ...}`, the seat
 * loop parks the run, and `Orchestrator.answer(runId, stepId, text)` releases it through the shared
 * `HumanAnswers`. In one-shot mode `trent run` reads that same gate event through
 * `questionFromEvent` and exits 7 with the approval id, exactly as it does for `ask_human`.
 * Nothing here invents an answer: a release with no text is a `failed` record that says so.
 */
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import { parseAction, record as toRecord, type ToolSpec } from "../action.js";
import { renderQuestions, sharedHumanAnswers, type HumanAnswers, type QuestionEntry, type QuestionsDetails } from "../human/index.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";

export const CLARIFY_ADAPTER_NAME = "clarify";
export const CLARIFY_SCOPES = ["clarify"];
/** Hermes's own cap. Beyond five the card stops being one decision and becomes a form. */
export const CLARIFY_MAX_QUESTIONS = 5;
const MAX_CHOICES = 8;

const SPECS: readonly ToolSpec[] = [{ name: CLARIFY_ADAPTER_NAME, primary: "question", signature: ["questions"] }];
const ROUTING_TEXT =
  "ask the founder several questions at once, clarify the brief, confirm the open decisions before " +
  "starting, batch the questions into one prompt, which option for each";

export const CLARIFY_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: CLARIFY_ADAPTER_NAME,
    description:
      `Ask the founder up to ${CLARIFY_MAX_QUESTIONS} independent questions in one card and wait for ` +
      "all the answers. Use it instead of several ask_human calls when the questions do not depend on " +
      "each other: one interruption, one reply. The step pauses until a human answers.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: `Up to ${CLARIFY_MAX_QUESTIONS} entries of {id, question, context, choices}; a plain string is taken as the question.`,
        },
        question: { type: "string", description: "A single question, when there is only one." },
        choices: { type: "array", items: { type: "string" }, description: `Up to ${MAX_CHOICES} suggested answers for a single question.` },
      },
      required: [],
    },
  },
];

/** The `needs_approval` record that parks the step, with the whole card as data beside the summary. */
export interface ClarifyRecord extends ToolCallRecord {
  readonly details: QuestionsDetails;
}

function stringsOf(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()).slice(0, cap);
}

function entryFrom(raw: unknown, index: number, used: Set<string>): QuestionEntry | undefined {
  const source = typeof raw === "string" ? { question: raw } : raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  if (source === undefined) return undefined;
  const question = typeof source.question === "string" ? source.question.trim() : "";
  if (question === "") return undefined;
  const wanted = typeof source.id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(source.id.trim()) ? source.id.trim() : `q${index + 1}`;
  let id = wanted;
  let suffix = 2;
  while (used.has(id)) {
    id = `${wanted}_${suffix}`;
    suffix += 1;
  }
  used.add(id);
  const context = typeof source.context === "string" && source.context.trim() !== "" ? source.context.trim() : undefined;
  const choices = stringsOf(source.choices, MAX_CHOICES);
  return { id, question, ...(context === undefined ? {} : { context }), ...(choices.length ? { choices } : {}) };
}

/** The card, or the one line the model needs to fix its call. */
export function toQuestions(args: Record<string, unknown>): QuestionsDetails | string {
  const raw = Array.isArray(args.questions)
    ? args.questions
    : typeof args.question === "string"
      ? [{ question: args.question, ...(args.choices === undefined ? {} : { choices: args.choices }) }]
      : [];
  if (raw.length === 0) return `clarify needs "questions": between 1 and ${CLARIFY_MAX_QUESTIONS} entries, each with a question.`;
  if (raw.length > CLARIFY_MAX_QUESTIONS) {
    return `clarify takes at most ${CLARIFY_MAX_QUESTIONS} questions and was given ${raw.length}. Ask the most important ${CLARIFY_MAX_QUESTIONS} now and the rest after the answers; none of them were asked.`;
  }
  const used = new Set<string>();
  const questions: QuestionEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    const parsed = entryFrom(entry, index, used);
    if (parsed === undefined) return `clarify question ${index + 1} has no non-empty "question"; nothing was asked.`;
    questions.push(parsed);
  }
  return { kind: "questions", questions };
}

function parseCard(action: string): QuestionsDetails | string {
  const { args, error } = parseAction(action, SPECS);
  if (error) return error;
  return toQuestions(args);
}

/**
 * Splits the founder's reply across the questions. Three shapes, in order: lines keyed by a
 * question id; one line per question in order; and anything else, which is handed back verbatim
 * with a note. The third case is deliberate — guessing which sentence answers which question is
 * exactly the invention this tool exists to avoid.
 */
export function splitAnswers(details: QuestionsDetails, reply: string): string {
  const ids = details.questions.map((entry) => entry.id);
  const lines = reply.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const keyed = new Map<string, string>();
  for (const line of lines) {
    const match = /^([A-Za-z0-9_-]{1,32})\s*[:=-]\s*(.+)$/.exec(line);
    if (match && ids.includes(match[1]!)) keyed.set(match[1]!, match[2]!.trim());
  }
  if (keyed.size > 0) {
    return ids.map((id) => `${id}: ${keyed.get(id) ?? "(not answered)"}`).join("\n");
  }
  if (lines.length === ids.length) return ids.map((id, index) => `${id}: ${lines[index]}`).join("\n");
  if (ids.length === 1) return `${ids[0]}: ${reply.trim()}`;
  return `the reply was not split per question; it is reproduced verbatim:\n${reply.trim()}`;
}

export interface ClarifyAdapterOptions {
  /** Defaults to the process-wide registry `Orchestrator.answer` writes to, as `ask_human` does. */
  readonly answers?: HumanAnswers;
}

export function createClarifyAdapter(options: ClarifyAdapterOptions = {}): TrentToolAdapter {
  const answers = options.answers ?? sharedHumanAnswers;
  const record = (action: string, status: ToolCallRecord["status"], summary: string): ToolCallRecord =>
    toRecord(CLARIFY_ADAPTER_NAME, action, status, summary);

  return {
    name: CLARIFY_ADAPTER_NAME,
    scopes: [...CLARIFY_SCOPES],
    availability: "real",
    instructions: renderToolInstructions(CLARIFY_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    /** True, so the guardrail executor parks the step through `dryRun`, exactly like `ask_human`. */
    requiresApproval: () => true,
    async dryRun(action) {
      const details = parseCard(action);
      if (typeof details === "string") return record(action, "failed", details);
      const parked: ClarifyRecord = {
        ...record(action, "needs_approval", `clarify is waiting for the founder's answers.\n${renderQuestions(details)}`),
        details,
      };
      return parked;
    },
    async execute(action) {
      const details = parseCard(action);
      if (typeof details === "string") return record(action, "failed", details);
      const context = currentToolCallContext();
      if (context === undefined) {
        return record(action, "failed", "clarify was called outside a run, where no step can park for the founder; no questions were asked.");
      }
      const reply = answers.take(context.runId, context.stepId);
      if (reply === undefined || reply.trim() === "") {
        return record(action, "failed", "clarify: the step was released with no answer, so nothing was learned; ask again or proceed without it.");
      }
      return record(action, "completed", splitAnswers(details, reply));
    },
    async cleanup() {},
  };
}
