/**
 * [H3] The shapes the webhook engine speaks: one delivery in, one HTTP answer out, one run started
 * through the runner port of the route's mode.
 *
 * The port is `@trent/core/agent-runner`'s `AgentRunner` widened by what a webhook run carries. The
 * CLI's `ModeRunner` (`apps/cli/src/runtime/runner-for-mode.ts`) satisfies it structurally: its
 * `run` reads `objective`, `signal` and `surface` and ignores the rest, so a runner that cannot
 * enforce `maxCostCents` itself is still held to it by the engine's own meter on the frames.
 */
import type { AgentRunInput } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import type { WEBHOOK_MODES } from "../config/sections/gateway.js";

export type WebhookMode = (typeof WEBHOOK_MODES)[number];

/** One request as the listener read it. Headers are lower-cased; the body is the raw bytes. */
export interface WebhookDelivery {
  readonly method: string;
  /** The URL path without the query string. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
  /** True when the listener stopped reading at the body cap. */
  readonly truncated?: boolean;
  /** The peer's address (`req.socket.remoteAddress`). */
  readonly peer: string;
  /** The address the listener itself is bound to. */
  readonly boundAddress: string;
}

export interface WebhookResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON text. Never the secret, never the payload. */
  readonly body: string;
}

/** What a run started by a webhook receives. */
export interface WebhookRunInput extends AgentRunInput {
  /** The inbound-provenance marker line, then the rendered template. */
  readonly objective: string;
  readonly signal: AbortSignal;
  readonly mode: WebhookMode;
  readonly surface: "webhook";
  readonly route: string;
  readonly deliveryId: string;
  /** The payload was written outside this machine: the same tag a business read's record carries. */
  readonly provenance: "untrusted";
  /** The source the run's policy ring is seeded with: `webhook:<route>`. */
  readonly inbound: string;
  readonly seat?: string;
  /** Integer cents. */
  readonly maxCostCents?: number;
}

export interface WebhookRunner {
  run(input: WebhookRunInput): AsyncIterable<OrcEvent>;
}

export type WebhookRunnerFor = (mode: WebhookMode) => WebhookRunner | undefined;

/** How a delivery was answered, and later how the run it started ended. */
export const DELIVERY_VERDICTS = [
  "started",
  "replay",
  "ignored",
  "bad_signature",
  "not_loopback",
  "no_secret",
  "rate_limited",
  "bad_body",
  "too_large",
  "method",
  "no_runner",
  "run_error",
  "completed",
  "failed",
  "cancelled",
  "input-required",
  "cost_cap",
] as const;
export type DeliveryVerdict = (typeof DELIVERY_VERDICTS)[number];

/** Verdicts that mean a run exists for the delivery's key. */
export const RUN_VERDICTS: readonly DeliveryVerdict[] = ["started", "completed", "failed", "cancelled", "input-required", "cost_cap"];

/** One line of `<profile>/webhooks/deliveries.jsonl`. */
export interface DeliveryRow {
  readonly at: string;
  readonly delivery: string;
  readonly route: string;
  readonly verdict: DeliveryVerdict;
  /** The HTTP status the delivery was answered with; absent on a run's outcome row. */
  readonly status?: number;
  readonly key?: string;
  readonly run_id?: string;
  readonly mode?: WebhookMode;
  /** Why, in a few words. Never the secret, never the payload. */
  readonly detail?: string;
}
