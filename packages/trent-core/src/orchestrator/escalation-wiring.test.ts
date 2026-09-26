/**
 * [L1] `models.escalate` reaches the three places that may use it: the env bridge a gateway built with
 * no arguments reads (`applyModelEnv`), a seat call that failed on the local model (`step_failed`, in the
 * seat port), and the planner/critic port (`portGatewayWithEscalation`, installed by the orchestrator).
 * Every hosted call is held until a human approves exactly it; the recorder proves none is made before.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBoundApprovalStore, installBoundApprovals, type BoundApprovalStore } from "../governance/bound-approvals.js";
import { ESCALATE_ENV } from "../model-gateway/escalation.js";
import { ALIAS_ENV } from "../model-gateway/providers.js";
import type { GatewayCompletion, GatewayStreamRequest, ModelGateway } from "../model-gateway/types.js";
import { applyModelEnv, type ModelEnvConfig } from "./model-env.js";
import { portGatewayWithEscalation } from "./port-escalation.js";
import { PortTally } from "./provider-ports.js";
import { createSeatChatPort, readSeatCallUsages } from "./seat-gateway-port.js";
import { SeatTurnError } from "./seat-constrained.js";
import type { SeatChatRequest } from "./types.js";

const KEYS = [ALIAS_ENV, ESCALATE_ENV.model, ESCALATE_ENV.provider, ESCALATE_ENV.on, "OPENAI_BASE_URL", "OPENAI_API_KEY", "MODEL_ALLOWED_PROVIDERS", "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC", "WORKBENCH_EXECUTOR_MODEL", "WORKBENCH_PLANNER_MODEL", "TRENT_JOB_TIMEOUT_MS", "EMBEDDING_MODEL"];
const saved = new Map<string, string | undefined>();
let profileDir = "";
let approvals: BoundApprovalStore;

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env[ALIAS_ENV] = "ollama";
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-escalation-wiring-"));
  approvals = createBoundApprovalStore({ profileDir });
  installBoundApprovals(approvals);
});
afterEach(() => {
  installBoundApprovals(undefined);
  fs.rmSync(profileDir, { recursive: true, force: true });
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function recorder() {
  const calls: GatewayStreamRequest[] = [];
  const gateway: ModelGateway = {
    complete: async (req): Promise<GatewayCompletion> => {
      calls.push(req);
      const hosted = req.provider === "google";
      return {
        text: hosted ? 'Here: {"toolCall":null,"summary":"hosted answer"}' : "not json",
        provider: hosted ? "google" : "openai", model: req.model ?? "qwen3.5:9b", modelTier: "sonnet", inputTokens: 100, outputTokens: 10,
        costCents: hosted ? 1 : 0, estimated: false, priced_as_default: false, unpriced: false, ...(hosted ? {} : { providerAlias: "ollama" }), finishReason: "stop",
      };
    },
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("unused");
    },
    resolveRoute: () => ({ providers: ["openai"], fallbackChain: ["openai"], modelTier: "sonnet", explicitModel: "qwen3.5:9b", modelForProvider: () => "qwen3.5:9b" }),
    configuredProviders: () => ["openai", "google"],
    estimateCostCents: () => 0,
  };
  return { gateway, calls, hosted: () => calls.filter((call) => call.provider === "google") };
}

const SEAT: SeatChatRequest = {
  model: "qwen3.5:9b", temperature: 0.2, response_format: { type: "json_object" },
  messages: [{ role: "system", content: "You are the engineer seat." }, { role: "user", content: "Seat: engineer\nObjective: fix the build\nAvailable tools: file_ops\nRespond as JSON." }],
};

function escalateOn(on: string): void {
  process.env[ESCALATE_ENV.provider] = "google";
  process.env[ESCALATE_ENV.model] = "gemini-3.6-pro";
  process.env[ESCALATE_ENV.on] = on;
}

describe("[L1] the bridge", () => {
  it("applyModelEnv writes models.escalate for the gateway the orchestrator builds with no arguments", () => {
    const report = applyModelEnv({ provider: "ollama", model: "qwen3.5:9b", models: { escalate: { provider: "google", model: "gemini-3.6-pro", on: ["planner"] } } } as ModelEnvConfig);
    expect(process.env[ESCALATE_ENV.on]).toBe("planner");
    expect(report.written).toEqual(expect.arrayContaining([ESCALATE_ENV.model, ESCALATE_ENV.provider, ESCALATE_ENV.on]));
  });
});

describe("[L1] step_failed: a seat call that failed on the local model", () => {
  it("is held, names the row, sends nothing hosted, and still carries what the local calls spent", async () => {
    escalateOn("step_failed");
    const { gateway, hosted } = recorder();
    const error = await createSeatChatPort(gateway)(SEAT).then(() => undefined, (caught: unknown) => caught as Error);
    const [row] = approvals.list();
    expect(row?.details.preview).toMatch(/^send a failed local step's prompt \(\d+ bytes\) to google gemini-3\.6-pro: it would leave this machine$/);
    expect(row?.agentId).toBe("engineer");
    expect(error?.message).toContain(`trent approvals approve ${row!.id}`);
    expect(hosted()).toEqual([]);
    expect(readSeatCallUsages(error)).toHaveLength(2);
  });

  it("once approved, the same failed call is answered by the hosted model through today's path", async () => {
    escalateOn("step_failed");
    const { gateway, hosted } = recorder();
    await createSeatChatPort(gateway)(SEAT).catch(() => undefined);
    approvals.decide(approvals.list()[0]!.id, "approved", "owner");
    const reply = await createSeatChatPort(gateway)(SEAT);
    expect(hosted()).toHaveLength(1);
    expect(hosted()[0]!.responseFormat).toBeUndefined();
    expect(reply.choices[0]!.message.content).toBe('{"toolCall":null,"summary":"hosted answer"}');
    expect(readSeatCallUsages(reply).map((usage) => usage.provider)).toEqual(["openai", "openai", "google"]);
  });

  it("without step_failed in `on`, the local failure is the call's failure and no row is made", async () => {
    escalateOn("planner");
    const { gateway, hosted } = recorder();
    await expect(createSeatChatPort(gateway)(SEAT)).rejects.toBeInstanceOf(SeatTurnError);
    expect(approvals.list()).toEqual([]);
    expect(hosted()).toEqual([]);
  });
});

describe("[L1] the planner/critic port", () => {
  it("names the role by the run's phase: planner until plan_end, critic after", async () => {
    escalateOn("critic");
    const { gateway, hosted } = recorder();
    const ports = new PortTally();
    const port = portGatewayWithEscalation(gateway, ports);
    await port.complete({ role: "planner", messages: [{ role: "user", content: "plan" }] });
    expect(approvals.list()).toEqual([]);
    ports.enterExecution();
    await port.complete({ role: "planner", messages: [{ role: "user", content: "critique" }] });
    expect(approvals.list().map((row) => row.details.tool)).toEqual(["critic"]);
    expect(hosted()).toEqual([]);
  });
});
