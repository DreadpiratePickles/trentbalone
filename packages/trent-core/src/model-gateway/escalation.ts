/**
 * [L1] Hosted escalation behind approval: `models.escalate` (02_plan/output/local-models-plan-2026-09-26.md,
 * L1 "Hybrid escalation"; Perplexity's on-device mode lets its local model consult a frontier "advisor"
 * only with approval after a privacy check, 01_discovery/output/harness-others-2026-09-26.md).
 *
 * A local profile may name ONE hosted model that only the listed roles may use: `planner`, `critic`, and
 * `step_failed` (a seat call that failed on the local model). Every such call goes through the side-effect
 * gate every send already uses (`governance/bound-approvals.ts`): it is held as a pending approval whose
 * preview names exactly what would leave the machine (the role, the prompt's size in bytes, the provider
 * and the model), and it is sent only after a human approves that exact call (`trent approvals approve
 * <id>`). The row's key carries the prompt's SHA-256, never its text, so an approval covers that prompt to
 * that model and nothing else; a different prompt is a new approval. Unset by default.
 *
 * What a held call does meanwhile is the caller's: a planner or critic call is answered by the local model
 * (`withRoleEscalation`), so a run is never stalled on a question nobody is watching; a failed seat step
 * stays failed and its error names the row (`orchestrator/seat-gateway-port.ts`).
 *
 * WHICH PROVIDERS. Under a local alias `OPENAI_BASE_URL` and `OPENAI_API_KEY` belong to the runtime
 * (`providers.ts` writes a placeholder key), so `openai` and the hosted aliases (`deepseek`, `groq`)
 * cannot be reached from this process; `google`, `anthropic`, `mistral` and `openrouter` keep keys of
 * their own. One outside that set is `unavailable`, before any row is made. Names only are logged.
 */

import crypto from "node:crypto";

import { currentBoundApprovals, requireBoundApproval, type BoundApprovalStore, type BoundCall } from "../governance/bound-approvals.js";
import { activeProviderAlias, isLocalAlias } from "./providers.js";
import type { GatewayCompletion, GatewayStreamRequest, ModelGateway, ModelProvider } from "./types.js";
import { StructuredLogger } from "../telemetry/logger.js";

export const ESCALATION_ROLES = ["planner", "critic", "step_failed"] as const;
export type EscalationRole = (typeof ESCALATION_ROLES)[number];

/** The approval rows' adapter name, as `trent approvals list` shows it. */
export const ESCALATION_ADAPTER = "model_escalation";

export const ESCALATE_ENV = { model: "TRENT_ESCALATE_MODEL", provider: "TRENT_ESCALATE_PROVIDER", on: "TRENT_ESCALATE_ON" } as const;

/** The providers a hosted escalation can reach while a local alias owns the OpenAI variables. */
const REACHABLE_BESIDE_A_LOCAL_ALIAS: ReadonlySet<string> = new Set(["google", "anthropic", "mistral", "openrouter"]);
const HOSTED_PROVIDERS: ReadonlySet<string> = new Set(["openai", "google", "anthropic", "mistral", "openrouter"]);

/** The `models.escalate` block. */
export interface EscalateConfig {
  readonly model?: string;
  readonly provider?: string;
  readonly on: readonly string[];
}

export interface EscalationPolicy {
  readonly provider: string;
  readonly model?: string;
  readonly on: readonly EscalationRole[];
}

function isRole(value: string): value is EscalationRole {
  return (ESCALATION_ROLES as readonly string[]).includes(value);
}

/** The provider a hosted model id belongs to, when the config names only the model. */
function providerOfModel(model: string): string | undefined {
  const id = model.toLowerCase();
  if (id.includes("/")) return "openrouter";
  if (id.includes("claude")) return "anthropic";
  if (id.includes("gemini")) return "google";
  if (/mistral|mixtral|codestral|magistral/.test(id)) return "mistral";
  if (/^(gpt|o1|o3|o4)/.test(id)) return "openai";
  return undefined;
}

/** Writes what is configured, and nothing else. Returns the variable NAMES written. */
export function applyEscalationEnv(config: EscalateConfig | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  if (config === undefined) return [];
  const written: string[] = [];
  const write = (name: string, value: string | undefined): void => {
    if (value === undefined || value.trim() === "") return;
    env[name] = value.trim();
    written.push(name);
  };
  write(ESCALATE_ENV.model, config.model);
  write(ESCALATE_ENV.provider, config.provider);
  write(ESCALATE_ENV.on, config.on.filter(isRole).join(","));
  return written;
}

/** The policy the bridge carries, or undefined when escalation is not configured. */
export function escalationPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): EscalationPolicy | undefined {
  const on = (env[ESCALATE_ENV.on] ?? "").split(",").map((role) => role.trim()).filter(isRole);
  const model = env[ESCALATE_ENV.model]?.trim() || undefined;
  const provider = env[ESCALATE_ENV.provider]?.trim().toLowerCase() || (model === undefined ? undefined : providerOfModel(model));
  if (on.length === 0 || provider === undefined) return undefined;
  return { provider, ...(model === undefined ? {} : { model }), on };
}

const ROLE_WORDS: Readonly<Record<EscalationRole, string>> = { planner: "the planner's prompt", critic: "the critic's prompt", step_failed: "a failed local step's prompt" };

/** The approval card's text: exactly what would leave the machine, and to whom. */
export function escalationPreview(input: { readonly role: EscalationRole; readonly provider: string; readonly model: string; readonly promptBytes: number }): string {
  return `send ${ROLE_WORDS[input.role]} (${input.promptBytes} bytes) to ${input.provider} ${input.model}: it would leave this machine`;
}

export type EscalationOutcome =
  | { readonly kind: "not_configured" }
  | { readonly kind: "not_allowed"; readonly role: EscalationRole }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "held"; readonly preview: string; readonly approvalId?: string; readonly summary: string }
  | { readonly kind: "answered"; readonly completion: GatewayCompletion; readonly approvalId: string };

export interface EscalateInput {
  readonly role: EscalationRole;
  readonly request: GatewayStreamRequest;
  readonly gateway: ModelGateway;
  readonly policy?: EscalationPolicy | undefined;
  /** Defaults to the store this process's tools bind against (`currentBoundApprovals`). */
  readonly approvals?: BoundApprovalStore | undefined;
  readonly runId?: string;
  readonly stepId?: string;
  readonly seat?: string;
}

function unavailable(policy: EscalationPolicy, gateway: ModelGateway): string | undefined {
  if (!HOSTED_PROVIDERS.has(policy.provider)) return `models.escalate.provider ${policy.provider} is not a hosted provider`;
  if (isLocalAlias(activeProviderAlias()) && !REACHABLE_BESIDE_A_LOCAL_ALIAS.has(policy.provider)) {
    return `${policy.provider} shares the local runtime's OPENAI_* variables in this process; escalate to google, anthropic, mistral or openrouter`;
  }
  if (!gateway.configuredProviders().includes(policy.provider as ModelProvider)) return `${policy.provider} has no API key in this profile`;
  return undefined;
}

/** One call, gated: held until a human approves exactly it, then answered by the hosted model. */
export async function escalate(input: EscalateInput): Promise<EscalationOutcome> {
  const policy = input.policy;
  if (policy === undefined) return { kind: "not_configured" };
  if (!policy.on.includes(input.role)) return { kind: "not_allowed", role: input.role };
  const reason = unavailable(policy, input.gateway);
  if (reason !== undefined) return { kind: "unavailable", reason };
  const provider = policy.provider as ModelProvider;
  const model = policy.model ?? input.gateway.resolveRoute("planner").modelForProvider(provider);
  const prompt = input.request.messages.map((message) => message.content).join("\n");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const promptSha256 = crypto.createHash("sha256").update(prompt).digest("hex");
  const preview = escalationPreview({ role: input.role, provider, model, promptBytes });
  const args = { role: input.role, provider, model, promptBytes, promptSha256 };
  const call: BoundCall = {
    adapter: ESCALATION_ADAPTER,
    tool: input.role,
    action: `${input.role} ${JSON.stringify(args)}`,
    args,
    classes: ["external_send"],
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    ...(input.seat === undefined ? {} : { seat: input.seat }),
  };
  const decision = requireBoundApproval(call, preview, input.approvals ?? currentBoundApprovals());
  if (!decision.granted) return { kind: "held", preview, ...(decision.row === undefined ? {} : { approvalId: decision.row.id }), summary: decision.record.summary };
  const completion = await input.gateway.complete({ ...input.request, provider, model });
  return { kind: "answered", completion, approvalId: decision.row.id };
}

export interface RoleEscalationDeps {
  readonly policy?: () => EscalationPolicy | undefined;
  readonly approvals?: () => BoundApprovalStore | undefined;
  readonly runId?: () => string | undefined;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * The planner/critic port's gateway with escalation: `roleOf` says which of the two this call is. A
 * listed role on a local profile is gated; a held call is answered by the local model and logged with
 * the row to decide. Anything else passes straight through.
 */
export function withRoleEscalation(gateway: ModelGateway, roleOf: () => "planner" | "critic", deps: RoleEscalationDeps = {}): ModelGateway {
  const logger = deps.log === undefined ? new StructuredLogger({ runId: "model-gateway" }) : undefined;
  const log = deps.log ?? ((event: string, fields: Record<string, unknown>) => logger?.warn(event, fields));
  return {
    ...gateway,
    complete: async (request) => {
      const policy = (deps.policy ?? escalationPolicyFromEnv)();
      const role = roleOf();
      if (policy === undefined || !policy.on.includes(role) || !isLocalAlias(activeProviderAlias())) return gateway.complete(request);
      const runId = deps.runId?.();
      const outcome = await escalate({ role, request, gateway, policy, approvals: deps.approvals?.() ?? currentBoundApprovals(), ...(runId === undefined ? {} : { runId }) });
      if (outcome.kind === "answered") return outcome.completion;
      if (outcome.kind === "held") log("model_gateway.escalation_held", { role, provider: policy.provider, ...(outcome.approvalId === undefined ? {} : { approvalId: outcome.approvalId }) });
      if (outcome.kind === "unavailable") log("model_gateway.escalation_unavailable", { role, provider: policy.provider, reason: outcome.reason });
      return gateway.complete(request);
    },
  };
}
