/**
 * [L1] Hosted escalation behind approval (`models.escalate`), Perplexity's on-device pattern on
 * Trent's own gate: a local profile may name ONE hosted model that only the listed roles may use
 * (`planner`, `critic`, `step_failed`), and every such call is held as a bound approval
 * (`governance/bound-approvals.ts`) whose preview names exactly what would leave the machine: the role,
 * the prompt's size in bytes, the provider and the model. Nothing hosted is called before a human
 * approves that exact call. Unset by default.
 *
 * The approval rows live in a temporary profile's `gateway.json`; the gateway is a recorder. Nothing
 * here leaves the machine.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBoundApprovalStore, type BoundApprovalStore } from "../governance/bound-approvals.js";
import {
  ESCALATE_ENV,
  applyEscalationEnv,
  escalate,
  escalationPolicyFromEnv,
  escalationPreview,
  withRoleEscalation,
  type EscalationPolicy,
} from "./escalation.js";
import { ALIAS_ENV } from "./providers.js";
import type { GatewayCompletion, GatewayStreamRequest, ModelGateway, ModelProvider } from "./types.js";

const POLICY: EscalationPolicy = { provider: "google", model: "gemini-3.6-pro", on: ["planner", "step_failed"] };
const PROMPT = [{ role: "system" as const, content: "Plan the week." }, { role: "user" as const, content: "Objective: open a second bakery." }];
const PROMPT_BYTES = Buffer.byteLength(PROMPT.map((m) => m.content).join("\n"), "utf8");

function recorder(configured: ModelProvider[] = ["openai", "google"]) {
  const calls: GatewayStreamRequest[] = [];
  const gateway: ModelGateway = {
    complete: async (req): Promise<GatewayCompletion> => {
      calls.push(req);
      const hosted = req.provider === "google";
      return { text: hosted ? "hosted plan" : "local plan", provider: hosted ? "google" : "openai", model: req.model ?? "qwen3.5:9b", modelTier: "opus", inputTokens: 10, outputTokens: 5, costCents: hosted ? 1 : 0, estimated: false, priced_as_default: false, unpriced: false, finishReason: "stop" };
    },
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("unused");
    },
    resolveRoute: () => ({ providers: ["openai"], fallbackChain: ["openai"], modelTier: "opus", explicitModel: "qwen3.5:9b", modelForProvider: (p) => (p === "google" ? "gemini-3.6-flash" : "qwen3.5:9b") }),
    configuredProviders: () => configured,
    estimateCostCents: () => 0,
  };
  return { gateway, calls, hosted: () => calls.filter((call) => call.provider === "google") };
}

let profileDir = "";
let approvals: BoundApprovalStore;
const savedAlias = process.env[ALIAS_ENV];
beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-escalation-"));
  approvals = createBoundApprovalStore({ profileDir });
  process.env[ALIAS_ENV] = "ollama";
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  if (savedAlias === undefined) delete process.env[ALIAS_ENV];
  else process.env[ALIAS_ENV] = savedAlias;
});

describe("[L1] the policy reaches a gateway built with no arguments", () => {
  it("round-trips through the env bridge, and is absent when unset", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(escalationPolicyFromEnv(env)).toBeUndefined();
    expect(applyEscalationEnv({ model: "gemini-3.6-pro", provider: "google", on: ["planner", "step_failed"] }, env)).toEqual([ESCALATE_ENV.model, ESCALATE_ENV.provider, ESCALATE_ENV.on]);
    expect(escalationPolicyFromEnv(env)).toEqual(POLICY);
  });

  it("names the provider from the model when only the model is given", () => {
    const env: NodeJS.ProcessEnv = {};
    applyEscalationEnv({ model: "claude-sonnet-4-6", on: ["critic"] }, env);
    expect(escalationPolicyFromEnv(env)).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6", on: ["critic"] });
  });
});

describe("[L1] the preview names exactly what would leave the machine", () => {
  it("the role, the prompt's size in bytes, the provider and the model", () => {
    expect(escalationPreview({ role: "planner", provider: "google", model: "gemini-3.6-pro", promptBytes: 1234 })).toBe(
      "send the planner's prompt (1234 bytes) to google gemini-3.6-pro: it would leave this machine",
    );
  });
});

describe("[L1] nothing hosted is called without the approval", () => {
  it("unset or a role not listed: no row, no hosted call", async () => {
    const { gateway, calls } = recorder();
    expect(await escalate({ role: "planner", request: { messages: PROMPT }, gateway, approvals })).toEqual({ kind: "not_configured" });
    expect(await escalate({ role: "critic", request: { messages: PROMPT }, gateway, policy: POLICY, approvals })).toEqual({ kind: "not_allowed", role: "critic" });
    expect(calls).toEqual([]);
    expect(approvals.list()).toEqual([]);
  });

  it("the first call is HELD as a pending approval carrying the preview; no hosted call is made", async () => {
    const { gateway, calls } = recorder();
    const outcome = await escalate({ role: "planner", request: { messages: PROMPT }, gateway, policy: POLICY, approvals });
    expect(outcome.kind).toBe("held");
    expect(calls).toEqual([]);
    const [row] = approvals.list();
    expect(row?.details.preview).toBe(escalationPreview({ role: "planner", provider: "google", model: "gemini-3.6-pro", promptBytes: PROMPT_BYTES }));
    expect(row?.details.args).toMatchObject({ role: "planner", provider: "google", model: "gemini-3.6-pro", promptBytes: PROMPT_BYTES });
    expect(JSON.stringify(row)).not.toContain("second bakery"); // the row carries a hash, never the prompt
    expect(outcome.kind === "held" ? outcome.summary : "").toContain(`trent approvals approve ${row!.id}`);
  });

  it("after the owner approves exactly that call, it goes to the hosted model once; a different prompt is held again", async () => {
    const { gateway, hosted } = recorder();
    await escalate({ role: "planner", request: { messages: PROMPT }, gateway, policy: POLICY, approvals });
    approvals.decide(approvals.list()[0]!.id, "approved", "owner");
    const answered = await escalate({ role: "planner", request: { messages: PROMPT }, gateway, policy: POLICY, approvals });
    expect(answered).toMatchObject({ kind: "answered", completion: { text: "hosted plan", provider: "google" } });
    expect(hosted()).toHaveLength(1);
    expect(hosted()[0]).toMatchObject({ provider: "google", model: "gemini-3.6-pro" });
    const other = await escalate({ role: "planner", request: { messages: [{ role: "user", content: "a different objective" }] }, gateway, policy: POLICY, approvals });
    expect(other.kind).toBe("held");
    expect(hosted()).toHaveLength(1);
  });

  it("a rejected call stays local, and with no approval store open nothing can be approved", async () => {
    const { gateway, hosted } = recorder();
    await escalate({ role: "step_failed", request: { messages: PROMPT }, gateway, policy: POLICY, approvals });
    approvals.decide(approvals.list()[0]!.id, "denied", "owner");
    expect((await escalate({ role: "step_failed", request: { messages: PROMPT }, gateway, policy: POLICY, approvals })).kind).toBe("held");
    expect((await escalate({ role: "step_failed", request: { messages: PROMPT }, gateway, policy: POLICY })).kind).toBe("held");
    expect(hosted()).toEqual([]);
  });

  it("a provider with no key, or one that shares the local alias's endpoint, is unavailable before any row is made", async () => {
    const { gateway, calls } = recorder(["openai"]);
    expect(await escalate({ role: "planner", request: { messages: PROMPT }, gateway, policy: POLICY, approvals })).toMatchObject({ kind: "unavailable" });
    const viaAlias = await escalate({ role: "planner", request: { messages: PROMPT }, gateway: recorder().gateway, policy: { provider: "openai", model: "gpt-5.2", on: ["planner"] }, approvals });
    expect(viaAlias).toMatchObject({ kind: "unavailable" });
    expect(calls).toEqual([]);
    expect(approvals.list()).toEqual([]);
  });
});

describe("[L1] the planner and critic ports", () => {
  it("a held planner call is answered by the local model; an unlisted role is never escalated", async () => {
    const { gateway, calls, hosted } = recorder();
    let role: "planner" | "critic" = "planner";
    const held: string[] = [];
    const escalating = withRoleEscalation(gateway, () => role, { policy: () => POLICY, approvals: () => approvals, log: (event) => held.push(event) });
    expect((await escalating.complete({ role: "planner", messages: PROMPT })).text).toBe("local plan");
    expect(held).toEqual(["model_gateway.escalation_held"]);
    role = "critic";
    expect((await escalating.complete({ role: "planner", messages: PROMPT })).text).toBe("local plan");
    expect(approvals.list()).toHaveLength(1);
    expect(hosted()).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("an approved planner call is answered by the hosted model", async () => {
    const { gateway, hosted } = recorder();
    const escalating = withRoleEscalation(gateway, () => "planner", { policy: () => POLICY, approvals: () => approvals, log: () => undefined });
    await escalating.complete({ role: "planner", messages: PROMPT });
    approvals.decide(approvals.list()[0]!.id, "approved", "owner");
    expect((await escalating.complete({ role: "planner", messages: PROMPT })).text).toBe("hosted plan");
    expect(hosted()).toHaveLength(1);
  });

  it("a hosted profile never escalates: the policy is for a local runtime", async () => {
    delete process.env[ALIAS_ENV];
    const { gateway, hosted } = recorder();
    const escalating = withRoleEscalation(gateway, () => "planner", { policy: () => POLICY, approvals: () => approvals, log: () => undefined });
    await escalating.complete({ role: "planner", messages: PROMPT });
    expect(approvals.list()).toEqual([]);
    expect(hosted()).toEqual([]);
  });
});
