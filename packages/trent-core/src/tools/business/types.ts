/**
 * What one business tool looks like to the adapter: a synchronous `preview` that renders the
 * exact thing a human is asked to approve (and refuses bad arguments before anyone is asked),
 * and a `run` that performs it over the provider client. Reads have no preview.
 */
import type { ProviderHttp } from "./http.js";

export interface BusinessEnv {
  readonly http: ProviderHttp;
  /**
   * The bound-call key of exactly this call (`governance/bound-approvals.ts` boundCallKey):
   * the material for provider-side idempotency (Stripe's `Idempotency-Key`, Square's
   * `idempotency_key`, a client-supplied Calendar event id), so a replay the wrapper does not
   * key is still one side effect at the provider.
   */
  readonly key: string;
  /** True inside a seat turn (a run and a step are known); false for a direct REPL call. */
  readonly inRun: boolean;
}

export interface ExternalCharge {
  readonly provider: string;
  /** Integer cents. */
  readonly cents: number;
  readonly units: number;
  readonly model: string;
}

export interface HandlerResult {
  readonly summary: string;
  /** True when the summary carries text somebody outside this machine wrote. */
  readonly untrusted?: boolean;
  /** Money the provider billed for this call, for the spend ledger. */
  readonly charge?: ExternalCharge;
}

export interface BusinessHandler {
  /** Writes only: the line the founder judges. Throws `BusinessArgError` on a bad argument. */
  readonly preview?: (args: Record<string, unknown>) => string;
  readonly run: (env: BusinessEnv, args: Record<string, unknown>) => Promise<HandlerResult>;
}

export type HandlerTable = Readonly<Record<string, BusinessHandler>>;
