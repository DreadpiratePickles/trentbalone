/**
 * [C16] The bench's shapes: a task (its setup, its objective, the owner's policy and its grader), the fake
 * world a task runs against, one attempt's result, and the harnesses.
 *
 * A task is graded by the END STATE of the fake servers and the workspace, never by a model: `observe`
 * projects the world onto a flat record and `expect` is what that record must equal, key by key; `forbidden`
 * names provider operations that must never have reached a fake. The grader is `grade.ts`.
 */
import type { SpendRow } from "../governance/spend-ledger.js";

/** The three harnesses the bench can drive. */
export type HarnessId = "trent-solo" | "trent-fleet" | "hermes";

export const HARNESS_IDS: readonly HarnessId[] = ["trent-solo", "hermes", "trent-fleet"];

/** What a task exercises; the fleet keeps `--team` only if it wins one of these (council C16). */
export type TaskClass = "booking" | "billing" | "message" | "files" | "guard";

export const TASK_CLASSES: readonly TaskClass[] = ["booking", "billing", "message", "files", "guard"];

export interface StripeCustomerSeed {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** A Stripe invoice already in the world (a draft to send, or one already sent). */
export interface StripeInvoiceSeed {
  readonly id: string;
  readonly customer: string;
  readonly status: "draft" | "open";
  readonly totalCents: number;
  readonly currency: string;
  /** True when it was already emailed before the task began. */
  readonly sent?: boolean;
}

export interface CalendarEventSeed {
  readonly id: string;
  readonly summary: string;
  /** RFC 3339 with an offset. */
  readonly start: string;
  readonly end: string;
  readonly attendees?: readonly string[];
}

export interface SquareBookingSeed {
  readonly id: string;
  readonly customerId: string;
  readonly startAt: string;
  readonly serviceVariationId: string;
  readonly teamMemberId: string;
  readonly customerNote?: string;
}

/** Everything a task starts from. The business notes file is always written; `files` adds to it. */
export interface WorldSeed {
  readonly stripeCustomers?: readonly StripeCustomerSeed[];
  readonly stripeInvoices?: readonly StripeInvoiceSeed[];
  readonly calendarEvents?: readonly CalendarEventSeed[];
  readonly squareBookings?: readonly SquareBookingSeed[];
  /** Workspace files, by path relative to the workspace. */
  readonly files?: Readonly<Record<string, string>>;
}

export interface InvoiceLine {
  readonly description: string;
  readonly unitCents: number;
  readonly quantity: number;
}

export interface StripeInvoiceState {
  readonly id: string;
  readonly customer: string;
  readonly customerEmail: string;
  status: "draft" | "open";
  readonly currency: string;
  readonly lines: InvoiceLine[];
  /** Seeded invoices carry their total; created ones sum their lines. */
  readonly seededTotalCents?: number;
  /** How many times the fake emailed it (a `send`), including before the task when seeded as sent. */
  sendCount: number;
  readonly created: boolean;
}

export interface StripeQuoteState {
  readonly id: string;
  readonly customer: string;
  readonly totalCents: number;
  status: "draft" | "open";
}

export interface CalendarEventState {
  readonly id: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly attendees: readonly string[];
  status: "confirmed" | "cancelled";
  readonly created: boolean;
}

export interface SquareBookingState {
  readonly id: string;
  readonly customerId: string;
  readonly locationId: string;
  readonly startAt: string;
  readonly serviceVariationId: string;
  readonly teamMemberId: string;
  readonly customerNote?: string;
  status: "ACCEPTED" | "CANCELLED_BY_SELLER";
  version: number;
  readonly created: boolean;
}

export interface SquareInvoiceState {
  readonly id: string;
  readonly customerId: string;
  readonly totalCents: number;
  readonly currency: string;
  readonly dueDate: string;
  status: "DRAFT" | "UNPAID";
  publishCount: number;
}

export interface SmsState {
  readonly sid: string;
  readonly to: string;
  readonly from: string;
  readonly body: string;
}

/** The fake providers' state: what a real Stripe, Calendar, Square and Twilio account would hold. */
export interface BusinessState {
  readonly stripe: {
    readonly customers: StripeCustomerSeed[];
    readonly invoices: StripeInvoiceState[];
    readonly quotes: StripeQuoteState[];
    /** Payment links, with the total of their prices in integer cents. */
    readonly paymentLinks: { readonly id: string; readonly totalCents: number; readonly currency: string }[];
    /** Refunds that reached the fake (no Trent tool issues one; a harness's own path might). */
    readonly refunds: unknown[];
  };
  readonly calendar: { readonly events: CalendarEventState[] };
  readonly square: { readonly bookings: SquareBookingState[]; readonly invoices: SquareInvoiceState[] };
  readonly twilio: { readonly messages: SmsState[] };
}

/** One tool call a correct agent would make; `suite.test.ts` runs these to prove every task is solvable. */
export interface ReferenceCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** What the owner was asked, and what they said. */
export interface OperatorDecision {
  readonly tool: string;
  readonly args: unknown;
  readonly approved: boolean;
}

/** The read-only view of the world a task's `observe` gets. */
export interface WorldView {
  /** Provider-side operations in arrival order, e.g. `square.booking.create`, `twilio.sms.send`. */
  readonly operations: readonly string[];
  readonly state: BusinessState;
  /** Bluesky records created (posts and replies), as the fake received them. */
  readonly blueskyRecords: readonly { readonly text: string; readonly replyTo?: string }[];
  /** A workspace file's text, or undefined when it does not exist. */
  file(relativePath: string): string | undefined;
  /** Every decision the owner made during the attempt. */
  readonly decisions: readonly OperatorDecision[];
}

export interface BenchTask {
  readonly id: string;
  readonly title: string;
  readonly taskClass: TaskClass;
  /** Exactly what the harness is told. */
  readonly objective: string;
  readonly seed: WorldSeed;
  /** The tools the owner approves when asked; every other held call is rejected. */
  readonly approves: readonly string[];
  /** The end state as a flat record; compared with `expect` key by key (`state_check`). */
  readonly observe: (world: WorldView) => Record<string, unknown>;
  readonly expect: Readonly<Record<string, unknown>>;
  /** Provider operations that must never happen (`tool_call` forbidden). */
  readonly forbidden?: readonly string[];
  readonly reference: readonly ReferenceCall[];
}

export interface BenchSuite {
  readonly id: string;
  readonly title: string;
  readonly tasks: readonly BenchTask[];
}

/** One grader's verdict, for the report and a reader debugging a failure. */
export interface GradeCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface TaskGrade {
  readonly passed: boolean;
  /** The eval harness's weighted score; the bench passes a task only at 1. */
  readonly score: number;
  readonly checks: readonly GradeCheck[];
  readonly failureTags: readonly string[];
}

/** Tokens as the provider reported them. */
export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cachedInput: number;
}

/** One attempt of one task on one harness. Money is integer cents and integer micro-cents. */
export interface TaskRun {
  readonly taskId: string;
  readonly taskClass: TaskClass;
  readonly harness: HarnessId;
  /** 1-based. */
  readonly attempt: number;
  readonly passed: boolean;
  readonly grade: TaskGrade;
  /** How the harness itself ended: its own verdict, independent of the grade. */
  readonly status: "completed" | "failed" | "cancelled" | "timeout" | "error";
  readonly wallMs: number;
  /** Null when no model output was seen at all. */
  readonly ttftMs: number | null;
  /** What the ledger charged for the model calls, integer cents. */
  readonly ledgerCents: number;
  /** The list price of the same tokens, integer micro-cents (1 cent = 1,000,000). */
  readonly microCents: number;
  readonly tokens: TokenCounts;
  /** True when some tokens could not be priced from the table (the cents are the gateway's stand-in). */
  readonly unpriced: boolean;
  readonly error?: string;
}

/** A harness as the bench driver sees it: one attempt at a time, on a world the driver has reset. */
export interface HarnessAttemptInput {
  readonly task: BenchTask;
  readonly attempt: number;
}

export type SpendRows = readonly SpendRow[];
