/**
 * The `business` toolset (design B3-core): the jobs a spa or a contractor pays for, each behind
 * the gate of `docs/security.md` "Side-effecting tools".
 *
 *   customer_search                        Stripe customer lookup (a plain read)
 *   stripe_invoice_create / _send          draft, then finalize and email
 *   stripe_quote_create                    a finalized estimate
 *   stripe_payment_link_create             a link anyone can pay
 *   calendar_list / _appointment_create / _appointment_cancel   Google Calendar
 *   square_bookings_list / _booking_create / _booking_cancel   Square Appointments
 *   square_invoice_create / _send          Square invoices
 *   sms_send                               Twilio, outbound only
 *
 * Every write: `requiresApproval` answers true, `preview` renders the recipient, the amount with
 * its currency, the date and time or the message text, and `execute` calls
 * `requireBoundApproval` with that preview before it sends anything, so the call runs only
 * against an approval bound to exactly these arguments. Every write is keyed by the wrapper, so
 * a replay is answered from the idempotency store, and every write also carries provider-side
 * idempotency from the same key (`types.ts`) for a replay that reaches the provider anyway.
 * Every HTTP call goes out through the egress client with the provider's token from
 * `tokenResolver`, never from the environment. SMS spend lands on the ledger in integer cents.
 * The two reads that return customer-authored text tag their record untrusted, which the policy
 * ring reads as an inbound call for `send-after-untrusted`.
 */
import { createTokenResolver } from "../../connect/resolver.js";
import { boundCallKey, currentBoundApprovals, requireBoundApproval, type BoundCall } from "../../governance/bound-approvals.js";
import { toolNameOf } from "../../governance/idempotent-dispatch.js";
import { recordToolSpend, type SpendLedger } from "../../governance/spend-ledger.js";
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import { isTrentError } from "../../errors/index.js";
import { parseAction, record } from "../action.js";
import { fitSummary, headTail, SUMMARY_LIMIT } from "../spillover.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { createEgressFetch, type EgressClientOptions, type FetchLike } from "../web/proxied-fetch.js";
import { renderToolInstructions } from "../web/schemas.js";
import { CALENDAR_HANDLERS } from "./calendar.js";
import { createProviderHttp, ProviderRequestError, type BusinessProviderId, type TokenLookup } from "./http.js";
import { BusinessArgError } from "./money.js";
import { BUSINESS_ADAPTER_NAME, BUSINESS_ROUTING_TEXT, BUSINESS_SPECS, BUSINESS_TOOL_NAMES, BUSINESS_TOOL_SCHEMAS, TOOL_CLASSES, WRITE_TOOLS } from "./schemas.js";
import { SMS_HANDLERS } from "./sms.js";
import { SQUARE_HANDLERS } from "./square.js";
import { STRIPE_HANDLERS } from "./stripe.js";
import type { BusinessEnv, HandlerTable } from "./types.js";

export { BUSINESS_ADAPTER_NAME, BUSINESS_ROUTING_TEXT, BUSINESS_TOOL_NAMES, BUSINESS_TOOL_SCHEMAS, TOOL_CLASSES, WRITE_TOOLS } from "./schemas.js";
export type { BusinessToolName } from "./schemas.js";
export { BUSINESS_HOSTS, BUSINESS_PROVIDERS, DEFAULT_ENDPOINTS, SQUARE_VERSION, ProviderRequestError } from "./http.js";
export type { BusinessProviderId, TokenLookup } from "./http.js";
export { formatMoney } from "./money.js";
export { SMS_SEGMENT_PRICE_TENTHS_OF_CENT, smsCents, smsSegments } from "./sms.js";

export const BUSINESS_SCOPES: readonly string[] = [BUSINESS_ADAPTER_NAME, ...BUSINESS_TOOL_NAMES];

const HANDLERS: HandlerTable = { ...STRIPE_HANDLERS, ...CALENDAR_HANDLERS, ...SQUARE_HANDLERS, ...SMS_HANDLERS };

export interface BusinessAdapterOptions {
  /** Route every request through the egress proxy. Required unless `fetchImpl` is given. */
  readonly egress?: Omit<EgressClientOptions, "lookup">;
  /** Direct transport for tests only; bypasses the proxy. */
  readonly fetchImpl?: FetchLike;
  /** Base URL per provider; tests point these at local fakes. */
  readonly endpoints?: Partial<Record<BusinessProviderId, string>>;
  /** The credential source. Defaults to `tokenResolver` over the profile secrets; tests stub it. */
  readonly tokens?: TokenLookup;
  /** The seat making the calls, named on the bound approval and the ledger row. */
  readonly seat?: string;
  /** Where an over-long listing spills (`<profile>/cache/spillover`); absent means summaries are clipped in place. */
  readonly profileDir?: string;
  /** Where external spend is written. Defaults to the ledger installed in this process. */
  readonly spend?: Pick<SpendLedger, "append">;
}

/** The arguments exactly as the wrapper keys them (`autonomy-dispatch.ts` argsOf): the JSON object, else the raw action. */
function boundArgsOf(action: string): unknown {
  const trimmed = action.trim();
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex === -1) return action;
  try {
    return JSON.parse(trimmed.slice(braceIndex)) as unknown;
  } catch {
    return action;
  }
}

export function createBusinessAdapter(options: BusinessAdapterOptions = {}): TrentToolAdapter {
  const transport: FetchLike | undefined = options.fetchImpl ?? (options.egress ? createEgressFetch(options.egress) : undefined);
  if (transport === undefined) throw new Error("the business toolset needs the egress proxy (or a test transport): every call leaves the machine");
  const tokens = options.tokens ?? createTokenResolver({ fetchImpl: transport });
  const http = createProviderHttp({ fetchImpl: transport, tokens, ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }) });
  const fail = (action: string, summary: string): ToolCallRecord => record(BUSINESS_ADAPTER_NAME, action, "failed", summary);

  function boundCall(action: string, tool: string): BoundCall {
    const context = currentToolCallContext();
    return {
      adapter: BUSINESS_ADAPTER_NAME,
      action,
      tool: toolNameOf(action),
      args: boundArgsOf(action),
      classes: TOOL_CLASSES[tool] ?? [],
      ...(context === undefined ? {} : { runId: context.runId, stepId: context.stepId }),
      ...(options.seat === undefined ? {} : { seat: options.seat }),
    };
  }

  /** The preview for a write, or the reason it cannot run; undefined for a read or an unknown tool. */
  function previewOf(tool: string, args: Record<string, unknown>): { preview?: string; refusal?: string } {
    const handler = HANDLERS[tool];
    if (handler?.preview === undefined) return {};
    try {
      return { preview: handler.preview(args) };
    } catch (error) {
      if (error instanceof BusinessArgError) return { refusal: error.message };
      throw error;
    }
  }

  function failureOf(action: string, tool: string, error: unknown): ToolCallRecord {
    if (error instanceof BusinessArgError) return fail(action, `${tool} did not run: ${error.message}`);
    if (error instanceof ProviderRequestError) return fail(action, `${tool} failed: ${error.message}`);
    if (isTrentError(error)) return fail(action, `${tool} did not run: ${error.message}`);
    return fail(action, `${tool} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }

  return {
    name: BUSINESS_ADAPTER_NAME,
    scopes: [...BUSINESS_SCOPES],
    availability: "real",
    spendsMoneyOnExecute: true,
    instructions: renderToolInstructions(BUSINESS_TOOL_SCHEMAS),
    routingText: BUSINESS_ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval(action) {
      const parsed = parseAction(action, BUSINESS_SPECS);
      return !parsed.error && WRITE_TOOLS.has(parsed.tool);
    },
    preview(action) {
      const parsed = parseAction(action, BUSINESS_SPECS);
      if (parsed.error || !WRITE_TOOLS.has(parsed.tool)) return undefined;
      const { preview, refusal } = previewOf(parsed.tool, parsed.args);
      return refusal === undefined ? preview : `${parsed.tool} cannot run: ${refusal}`;
    },
    async dryRun(action) {
      const parsed = parseAction(action, BUSINESS_SPECS);
      if (parsed.error) return fail(action, parsed.error);
      if (!WRITE_TOOLS.has(parsed.tool)) return record(BUSINESS_ADAPTER_NAME, action, "completed", `${parsed.tool} is a read; it runs without approval.`);
      const { preview, refusal } = previewOf(parsed.tool, parsed.args);
      if (preview === undefined) return fail(action, `${parsed.tool} did not run: ${refusal ?? "no preview"}`);
      const store = currentBoundApprovals();
      const call = boundCall(action, parsed.tool);
      // The wrapper stamps the row itself on the class floor; a write the classifier does not
      // floor (the calendar pair) is stamped here, so the replay in this seat turn is granted.
      const shown = store?.find(call);
      if (shown?.status === "pending" && shown.details.previewedAt !== undefined) {
        return record(BUSINESS_ADAPTER_NAME, action, "needs_approval", `${parsed.tool} sends nothing until exactly this call is approved.`);
      }
      const row = store?.preview(call, preview);
      return record(BUSINESS_ADAPTER_NAME, action, "needs_approval", `${BUSINESS_ADAPTER_NAME}: ${parsed.tool} needs a human before it runs${row === undefined ? "" : `. Approval ${row.id} covers exactly this call`}: ${preview}`);
    },
    async execute(action) {
      const parsed = parseAction(action, BUSINESS_SPECS);
      if (parsed.error) return fail(action, parsed.error);
      const handler = HANDLERS[parsed.tool];
      if (handler === undefined) return fail(action, `unknown business tool ${parsed.tool}`);
      const call = boundCall(action, parsed.tool);
      if (WRITE_TOOLS.has(parsed.tool)) {
        const { preview, refusal } = previewOf(parsed.tool, parsed.args);
        if (preview === undefined) return fail(action, `${parsed.tool} did not run: ${refusal ?? "no preview"}`);
        const decision = requireBoundApproval(call, preview);
        if (!decision.granted) return decision.record;
      }
      const context = currentToolCallContext();
      const env: BusinessEnv = { http, key: boundCallKey(call), inRun: context !== undefined };
      try {
        const result = await handler.run(env, parsed.args);
        let note = "";
        if (result.charge !== undefined) {
          const row = recordToolSpend(
            { run_id: context?.runId ?? "none", tool: parsed.tool, provider: result.charge.provider, cents: result.charge.cents, units: result.charge.units, model: result.charge.model, ...(options.seat === undefined ? {} : { seat: options.seat }) },
            options.spend,
          );
          if (row === undefined) note = ` (no spend ledger is open in this process, so the ${result.charge.cents} cents were not recorded against the daily cap)`;
        }
        const text = `${result.summary}${note}`;
        const done = record(BUSINESS_ADAPTER_NAME, action, "completed", options.profileDir === undefined ? headTail(text, SUMMARY_LIMIT) : fitSummary(text, options.profileDir, parsed.tool));
        return result.untrusted === true ? { ...done, provenance: "untrusted" } : done;
      } catch (error) {
        return failureOf(action, parsed.tool, error);
      }
    },
    cleanup: async () => undefined,
  };
}
