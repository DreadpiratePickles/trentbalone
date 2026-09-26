/**
 * `human`: Hermes's `ask_human` — the seat hands a decision to the founder and waits.
 *
 * No new parking mechanism is built. The tool rides the app's own tool-approval gate
 * (`external-action-guardrails.ts` -> `seat-agent-loop.ts` pauseForApproval): `requiresApproval`
 * answers true, so the guardrail executor calls `dryRun`, which returns the `needs_approval`
 * record carrying `details: {kind: "question", ...}`; the seat loop pauses and the run parks on
 * `step_awaiting_approval` / `run_awaiting_approval`. `Orchestrator.answer(runId, stepId, text)`
 * stores the text in a `HumanAnswers` registry and releases the step through the existing
 * `approve`; the seat loop replays the pending call with `approvalGranted`, `execute` reads the
 * answer through the tool-call context and returns it verbatim as the tool result.
 *
 * A delegated child cannot wait for a founder (delegate-child.ts): there the call is `blocked`
 * with a one-line reason. Nothing here ever invents an answer: a release without one is a
 * `failed` record that says so.
 */
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import type { OrcEvent } from "../../orchestrator/types.js";
import { parseAction, record as toRecord, type ToolSpec } from "../action.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";

export const HUMAN_ADAPTER_NAME = "human";
/** Neither name carries a side-effect token (idempotent-dispatch) nor a policy class (policy-rules). */
export const HUMAN_SCOPES = ["human", "ask_human"];
const SPECS: readonly ToolSpec[] = [{ name: "ask_human", primary: "question", signature: ["question"] }];
const ROUTING_TEXT =
  "ask the founder, ask the human, ask the user a question, need a decision from the owner, " +
  "which option should I take, confirm with the human before continuing, wait for the founder's answer";
const MAX_OPTIONS = 8;

export const HUMAN_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "ask_human",
    description:
      "Ask the founder a question and wait for the answer. The step pauses until a human replies (in the " +
      "REPL, or by chat when the gateway is running); the reply text is this tool's result. Use it for a " +
      "decision only a human can make. Never guess the answer; a delegated child cannot use it.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, self-contained: the founder sees nothing else of your conversation." },
        context: { type: "string", description: "What the founder needs to decide well: the trade-off, what you found, what happens either way." },
        options: { type: "array", description: `Up to ${MAX_OPTIONS} suggested answers, when the choice is between known alternatives.` },
      },
      required: ["question"],
    },
  },
];

export interface QuestionDetails {
  readonly kind: "question";
  readonly question: string;
  readonly context?: string;
  readonly options?: readonly string[];
}

/** The `needs_approval` record that parks the step, with the question as data next to the summary. */
export interface QuestionRecord extends ToolCallRecord {
  readonly details: QuestionDetails;
}

/** What the orchestrator knows about the step currently calling the tool. */
export interface HumanCallerContext {
  /** A `[delegated]` child step: it cannot wait for a founder, so the call is refused. */
  readonly delegated: boolean;
}

/**
 * Answers waiting for the replay of a parked `ask_human` call, keyed by run and step. The
 * orchestrator's `answer()` writes; the adapter's `execute` takes, once. One registry per
 * process by default (`sharedHumanAnswers`), so the tool builder and the orchestrator agree
 * without extra wiring; tests pass their own.
 */
export class HumanAnswers {
  readonly #answers = new Map<string, string>();

  put(runId: string, stepId: string, text: string): void {
    this.#answers.set(`${runId}/${stepId}`, text);
  }

  take(runId: string, stepId: string): string | undefined {
    const key = `${runId}/${stepId}`;
    const text = this.#answers.get(key);
    this.#answers.delete(key);
    return text;
  }
}

export const sharedHumanAnswers = new HumanAnswers();

export interface HumanAdapterOptions {
  readonly answers?: HumanAnswers;
  /** Consulted on every call; the orchestrator binds its delegated-step tracker here. */
  readonly callerContext?: () => HumanCallerContext;
}

export interface HumanAdapter extends TrentToolAdapter {
  /** Installs (or replaces) the caller-context provider. */
  bindCallerContext(provider: () => HumanCallerContext): void;
}

function toDetails(args: Record<string, unknown>): QuestionDetails | string {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (question === "") return 'ask_human needs a non-empty "question".';
  const context = typeof args.context === "string" && args.context.trim() !== "" ? args.context.trim() : undefined;
  const raw = Array.isArray(args.options) ? args.options : [];
  const options = raw.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim()).slice(0, MAX_OPTIONS);
  return { kind: "question", question, ...(context ? { context } : {}), ...(options.length ? { options } : {}) };
}

/**
 * A3 — one entry of a multi-question card (`tools/clarify`). The type lives here, not in
 * `clarify/`, so `questionFromEvent` can read a clarify card without importing the tool that
 * writes one: the surfaces (`repl/engine.ts`, `commands/groups/run.ts`, `gateway/RunApprovalLink`)
 * already read every gate through this one function and must not learn a second shape.
 */
export interface QuestionEntry {
  readonly id: string;
  readonly question: string;
  readonly context?: string;
  readonly choices?: readonly string[];
}

/** The `details` a multi-question card parks with. */
export interface QuestionsDetails {
  readonly kind: "questions";
  readonly questions: readonly QuestionEntry[];
}

/** Adapters that park a founder card. Both ride the app's tool-approval gate; nothing else does. */
export const CARD_ADAPTER_NAMES: readonly string[] = [HUMAN_ADAPTER_NAME, "clarify"];

/**
 * The card text for several questions at once: how to answer, then one line per question with its
 * choices beside it. The per-question choices are NOT flattened into `options` — a numbered list
 * that means something different on every line is a trap, so a multi-question card is answered in
 * text and only a single-question one keeps the numbered options the REPL already renders.
 */
export function renderQuestions(details: QuestionsDetails): string {
  const lines = [`${details.questions.length} questions. Answer each on its own line, as "<id>: <answer>".`, ""];
  for (const entry of details.questions) {
    lines.push(`${entry.id}: ${entry.question}`);
    if (entry.context) lines.push(`  ${entry.context}`);
    if (entry.choices?.length) lines.push(`  choices: ${entry.choices.join(", ")}`);
  }
  return lines.join("\n");
}

function fromQuestions(details: QuestionsDetails): QuestionDetails | undefined {
  const [single] = details.questions;
  if (single === undefined) return undefined;
  if (details.questions.length === 1) {
    return {
      kind: "question",
      question: single.question,
      ...(single.context === undefined ? {} : { context: single.context }),
      ...(single.choices?.length ? { options: [...single.choices] } : {}),
    };
  }
  return { kind: "question", question: renderQuestions(details) };
}

/** The card text a founder sees: the question, its context, and the suggested answers numbered. */
export function renderQuestion(details: QuestionDetails): string {
  const lines = [details.question];
  if (details.context) lines.push("", details.context);
  if (details.options?.length) lines.push("", ...details.options.map((option, i) => `${i + 1}. ${option}`));
  return lines.join("\n");
}

function parseDetails(action: string): QuestionDetails | string {
  const { args, error } = parseAction(action, SPECS);
  if (error) return error;
  return toDetails(args);
}

/** The question a parked step is waiting on, read off the gate event; undefined for any other gate. */
export function questionFromEvent(event: OrcEvent): QuestionDetails | undefined {
  if (event.kind !== "step_awaiting_approval" && event.kind !== "run_awaiting_approval") return undefined;
  const step = event.step as { seatLoopState?: { pendingToolCall?: { name?: string; action?: string } }; toolCalls?: ToolCallRecord[] } | undefined;
  const pending = step?.seatLoopState?.pendingToolCall;
  if (pending?.name !== undefined && HUMAN_SCOPES.includes(pending.name.toLowerCase()) && typeof pending.action === "string") {
    const details = parseDetails(pending.action);
    if (typeof details !== "string") return details;
  }
  // [S1.1] A gate that names its held call is answered by THAT call's record only (council B2). An
  // older `ask_human` stays in the step's cumulative list as `needs_approval` after it was answered,
  // so the newest card record is not the held call's: a `social_post` held later in the same step
  // must open an approval card, never the old question, or a typed reply would release the post.
  const named = pending?.name !== undefined && typeof pending.action === "string";
  const parked = [...(step?.toolCalls ?? [])]
    .reverse()
    .find((call) => CARD_ADAPTER_NAMES.includes(call.adapter) && call.status === "needs_approval" && (!named || call.action === pending?.action));
  const details = (parked as { details?: QuestionDetails | QuestionsDetails } | undefined)?.details;
  if (details?.kind === "questions" && Array.isArray(details.questions)) return fromQuestions(details);
  if (details?.kind === "question" && typeof details.question === "string") return details;
  if (parked) {
    const parsed = parseDetails(parked.action);
    if (typeof parsed !== "string") return parsed;
  }
  return undefined;
}

export function createHumanAdapter(options: HumanAdapterOptions = {}): HumanAdapter {
  const answers = options.answers ?? sharedHumanAnswers;
  let callerContext: () => HumanCallerContext = options.callerContext ?? (() => ({ delegated: false }));
  const record = (action: string, status: ToolCallRecord["status"], summary: string): ToolCallRecord => toRecord(HUMAN_ADAPTER_NAME, action, status, summary);
  const blocked = (action: string): ToolCallRecord =>
    record(action, "blocked", "ask_human is blocked: a delegated child cannot wait for the founder; report the open question to the parent instead.");

  return {
    name: HUMAN_ADAPTER_NAME,
    scopes: [...HUMAN_SCOPES],
    availability: "real",
    instructions: renderToolInstructions(HUMAN_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    /** True in a run, so the guardrail executor parks the step through `dryRun`; false in a child, where `execute` refuses. */
    requiresApproval: () => !callerContext().delegated,
    async dryRun(action) {
      const details = parseDetails(action);
      if (typeof details === "string") return record(action, "failed", details);
      if (callerContext().delegated) return blocked(action);
      const summary = `ask_human is waiting for the founder's answer.\n${renderQuestion(details)}`;
      const parked: QuestionRecord = { ...record(action, "needs_approval", summary), details };
      return parked;
    },
    async execute(action) {
      const details = parseDetails(action);
      if (typeof details === "string") return record(action, "failed", details);
      if (callerContext().delegated) return blocked(action);
      const context = currentToolCallContext();
      if (context === undefined) {
        return record(action, "failed", "ask_human was called outside a run, where no step can park for the founder; no answer was recorded.");
      }
      const answer = answers.take(context.runId, context.stepId);
      if (answer === undefined) {
        return record(action, "failed", "ask_human: the step was released without an answer, so there is nothing to report; ask again or proceed without it. No answer was invented.");
      }
      return record(action, "completed", answer);
    },
    bindCallerContext(provider) {
      callerContext = provider;
    },
    async cleanup() {},
  };
}
