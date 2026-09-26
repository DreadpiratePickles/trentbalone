/**
 * [S1] Fakes for the solo loop's tests: a scripted gateway, gated adapters, an in-memory session,
 * a fixed memory, a recording meter. Nothing here calls a model or touches the network; every
 * reply a test sees is one its own script wrote.
 */
import { currentToolCallContext, type ToolCallContext } from "../governance/tool-call-context.js";
import type { ContextBlock } from "../fleet-memory/tiers.js";
import type { GatewayCompletion, GatewayStreamRequest } from "../model-gateway/types.js";
import type { OrcEvent } from "../orchestrator/types.js";
import type { ToolCallRecord, ToolCallStatus, TrentToolAdapter } from "../tools/types.js";
import type { SoloGateway, SoloMemory, SoloMemoryRequest, SoloMessage, SoloMeter, SoloModelCall, SoloSession } from "./types.js";

export const FIXED_NOW = (): Date => new Date("2026-09-26T09:00:00.000Z");

/** `solo_1`, `solo_2`, ... so a run id can be asserted. */
export function sequentialIds(): (prefix: string) => string {
  let n = 0;
  return (prefix) => `${prefix}_${String(++n)}`;
}

export type ScriptStep = string | Error | ((request: GatewayStreamRequest) => string | Promise<string>);

export interface ScriptedGateway extends SoloGateway {
  readonly requests: GatewayStreamRequest[];
}

export function completion(text: string): GatewayCompletion {
  return {
    text,
    provider: "google",
    model: "gemini-test",
    modelTier: "sonnet",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
    costCents: 1,
    estimated: false,
    priced_as_default: false,
    unpriced: false,
    finishReason: "stop",
  };
}

/** Replies in order; a call past the end of the script throws, so an unexpected extra call fails loudly. */
export function scriptedGateway(script: readonly ScriptStep[]): ScriptedGateway {
  const requests: GatewayStreamRequest[] = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const step = script[requests.length - 1];
      if (step === undefined) throw new Error(`the test script has no reply for call ${String(requests.length)}`);
      if (step instanceof Error) throw step;
      return completion(typeof step === "function" ? await step(request) : step);
    },
  };
}

export const toolCall = (body: string): string => `<tool_call>\n${body}\n</tool_call>`;

export interface FakeCall {
  readonly action: string;
  readonly payload: Record<string, unknown>;
  readonly context: ToolCallContext | undefined;
}

export interface FakeAdapter extends TrentToolAdapter {
  readonly calls: FakeCall[];
  readonly dryRuns: FakeCall[];
}

export interface FakeAdapterOptions {
  readonly name: string;
  readonly tools: readonly string[];
  readonly approval?: (action: string) => boolean;
  readonly result?: (action: string, n: number) => { status: ToolCallStatus; summary: string } | Promise<{ status: ToolCallStatus; summary: string }>;
  readonly dryRun?: boolean;
}

/** An adapter shaped like a built one: its instructions document `<tool> <json>`, execute records where it was called from. */
export function fakeAdapter(options: FakeAdapterOptions): FakeAdapter {
  const calls: FakeCall[] = [];
  const dryRuns: FakeCall[] = [];
  const record = (action: string, status: ToolCallStatus, summary: string): ToolCallRecord => ({ adapter: options.name, action, status, summary });
  const adapter: FakeAdapter = {
    calls,
    dryRuns,
    name: options.name,
    scopes: [options.name, ...options.tools],
    instructions: options.tools.map((tool) => `${tool}: the ${tool} tool.\n  action = "${tool} {\\"...\\"}"`).join("\n\n"),
    routingText: options.tools.join(" "),
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: (action) => options.approval?.(action) ?? false,
    async execute(action, payload) {
      calls.push({ action, payload, context: currentToolCallContext() });
      const out = options.result ? await options.result(action, calls.length) : { status: "completed" as const, summary: `${options.name} ran ${action}` };
      return record(action, out.status, out.summary);
    },
    ...(options.dryRun === false
      ? {}
      : {
          async dryRun(action: string, payload: Record<string, unknown>) {
            dryRuns.push({ action, payload, context: currentToolCallContext() });
            return record(action, "needs_approval", `${options.name}: ${action} is held as appr_test until a human approves exactly this call.`);
          },
        }),
    cleanup: async () => undefined,
  };
  return adapter;
}

export interface MemorySession extends SoloSession {
  readonly messages: SoloMessage[];
}

export function memorySession(seed: readonly SoloMessage[] = []): MemorySession {
  const messages = [...seed];
  return {
    messages,
    history: async () => [...messages],
    append: async (added) => void messages.push(...added),
  };
}

export const STABLE_BLOCKS: readonly ContextBlock[] = [
  { tier: "stable", name: "company-memory", text: "## Company memory\nThe company sells hand-made oak tables." },
];

export interface FakeMemory {
  readonly memory: SoloMemory;
  readonly requests: SoloMemoryRequest[];
}

export function fakeMemory(context: readonly ContextBlock[] = [{ tier: "context", name: "brain-recall", text: "## Recall\nLast week the founder chose walnut stain." }]): FakeMemory {
  const requests: SoloMemoryRequest[] = [];
  return {
    requests,
    memory: async (request) => {
      requests.push(request);
      return { stable: STABLE_BLOCKS, context };
    },
  };
}

export interface FakeMeter extends SoloMeter {
  readonly calls: Array<{ runId: string; call: SoloModelCall }>;
  readonly opened: string[];
  readonly closed: string[];
}

/** Charges `centsPerCall` per call; with `stopAtCents`, says stop once the run has spent that much. */
export function fakeMeter(options: { centsPerCall?: number; stopAtCents?: number } = {}): FakeMeter {
  const calls: Array<{ runId: string; call: SoloModelCall }> = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const spent = new Map<string, number>();
  return {
    calls,
    opened,
    closed,
    open: (runId) => void opened.push(runId),
    close: (runId) => void closed.push(runId),
    record(runId, call) {
      calls.push({ runId, call });
      const cents = options.centsPerCall ?? 1;
      spent.set(runId, (spent.get(runId) ?? 0) + cents);
      return cents;
    },
    stopReason(runId) {
      const cap = options.stopAtCents;
      const total = spent.get(runId) ?? 0;
      return cap !== undefined && total >= cap ? `the run's budget is spent: ${String(total)} cents of a ${String(cap)}-cent cap` : undefined;
    },
  };
}

export async function collect(events: AsyncIterable<OrcEvent>): Promise<OrcEvent[]> {
  const out: OrcEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

export const kinds = (events: readonly OrcEvent[]): string[] => events.map((event) => event.kind);

/** The `toolCalls` a frame carries (the REPL reads the same field, `repl/render.ts`). */
export const toolCallsOf = (event: OrcEvent | undefined): ToolCallRecord[] => ((event?.step as { toolCalls?: ToolCallRecord[] } | undefined)?.toolCalls ?? []);

/** Every message of a request after the system prompt, as `role: content`, for asserting what the model was told. */
export const transcriptOf = (request: GatewayStreamRequest | undefined): string[] =>
  (request?.messages ?? []).filter((m) => m.role !== "system").map((m) => `${m.role}: ${m.content}`);
