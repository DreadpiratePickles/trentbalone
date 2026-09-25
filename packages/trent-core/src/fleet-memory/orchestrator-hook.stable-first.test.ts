/**
 * [P2-7] The STABLE tier is the head of every seat call's rendered prompt.
 *
 * The tiers exist so a provider's prompt cache can hit the stable tier (`tiers.ts`), and a cache
 * hits a PREFIX. Until this change the hook appended all three tiers to `dynamicPrompt`, which the
 * wrapped app renders after `Company`/`Seat`/`Objective` (`apps/web/lib/model-gateway.ts`
 * `buildSeatUserPrompt`), so two objectives diverged ~40 tokens in and the ~11k-token stable tier
 * was never a shared prefix: 0 cached tokens on gemini-3.6-flash, which caches 77 percent when it
 * is (docs/sessions/2026-09-25-p1c-model-cost.md, follow-up 1).
 *
 * These tests render the prompt with the app's REAL `executeSeatModel`, capturing the two messages
 * it would send through its `createChatCompletion` seam, so the layout under test is the provider's.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryImproveStore } from "../improve/memory-store.js";
import { SKILL_PRELUDE_MARKER, createSkillInjector } from "../improve/skill-injection.js";
import { createMemoryAdapter } from "../tools/memory/index.js";
import { createFleetMemoryHook, type FleetMemoryHook } from "./orchestrator-hook.js";
import { InMemoryFleetSource, type FleetRun } from "./source.js";

type Message = { role: "system" | "user"; content: string };
type Gateway = typeof import("@/lib/model-gateway");
type SeatInput = Parameters<Gateway["executeSeatModel"]>[0];

const COMPANY = "co_stable_first";
const SEAT_SYSTEM = "You are the engineer seat. Ship small, tested changes and say what you did not do.";
const PIPELINE_TEXT = "Previous step outputs:\n- s0 (analyst): the webhook retries three times.";
const WORKSPACE = "## Workspace context\nAGENTS.md: money is integer cents; failing test first.";
const PERSONALITY = "Tone stance: plain, short sentences.";
const OBJECTIVE_A = "Add signature verification to the refund webhook handler.";
const OBJECTIVE_B = "Draft the migration plan for the invoices table rename.";

let profileDir = "";

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-stable-first-"));
  fs.mkdirSync(path.join(profileDir, "memories"), { recursive: true });
  fs.writeFileSync(path.join(profileDir, "memories", "MEMORY.md"), "The company bills in integer cents.\n§\nWebhooks are verified before parsing.");
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function priorRun(): FleetRun {
  return {
    id: "run_prior", companyId: COMPANY, objective: "verify the refund webhook signature", status: "completed", summary: null,
    completedAt: "2026-09-24T10:00:00.000Z",
    steps: [{ id: "run_prior-s1", runId: "run_prior", agentRole: "engineer", title: "Refund webhook signature", status: "completed", output: "Refund webhook signature checked with the raw body." }],
  };
}

function subtaskFor(objective: string, seat = "engineer"): SeatInput["subtask"] {
  return {
    id: "step_1",
    seat,
    objective,
    boundaries: [],
    toolGuidance: [],
    input: {},
    contextBundle: { company: { name: "Northwind" }, overallObjective: objective },
    classification: { type: seat, complexity: "standard", reversibility: "reversible" },
  } as unknown as SeatInput["subtask"];
}

function harness() {
  const source = new InMemoryFleetSource();
  source.addRun(priorRun());
  const hook = createFleetMemoryHook({
    source,
    memory: createMemoryAdapter({ profileDir }),
    brain: false,
    workspaceContext: WORKSPACE,
    personalitySuffix: PERSONALITY,
  });
  return { hook };
}

/** The app's real seat call with the provider replaced by a recorder: returns the messages it would send. */
async function sendThroughApp(input: SeatInput): Promise<Message[]> {
  const gateway: Gateway = await import("@/lib/model-gateway");
  let sent: Message[] = [];
  await gateway.executeSeatModel({
    ...input,
    createChatCompletion: async (request) => {
      sent = request.messages;
      return { choices: [{ message: { content: '{"summary":"ok"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  });
  return sent;
}

/** One run, one seat call, through the hook and the app: the messages the provider would receive. */
async function renderRun(hook: FleetMemoryHook, runId: string, objective: string, withSystemPrompt = true): Promise<Message[]> {
  let sent: Message[] = [];
  const seat = hook.wrapSeatModel(async (input: SeatInput) => {
    sent = await sendThroughApp(input);
    return { output: {}, model: "recorder", tokens: 0, costCents: 0, fallback: false };
  });
  hook.runStarted({ runId, companyId: COMPANY, objective, history: [{ role: "user", content: "earlier turn about webhooks" }] });
  const input = { companyId: COMPANY, subtask: subtaskFor(objective), systemPrompt: SEAT_SYSTEM, dynamicPrompt: PIPELINE_TEXT };
  if (!withSystemPrompt) delete (input as Partial<typeof input>).systemPrompt;
  await seat(input as SeatInput);
  hook.runFinished(runId);
  return sent;
}

/** The request as a provider reads it, in order: every message's role and content. */
function rendered(messages: readonly Message[]): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n");
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("[P2-7] the stable tier leads every seat prompt", () => {
  it("for two different objectives on the same seat, the rendered prompt shares an identical leading prefix containing the stable tier, and the objective appears after it", async () => {
    const { hook } = harness();
    const first = rendered(await renderRun(hook, "run_a", OBJECTIVE_A));
    const second = rendered(await renderRun(hook, "run_b", OBJECTIVE_B));
    const stable = hook.stablePreludeFor("run_a") ?? "";

    // Preconditions: a real, byte-identical stable tier carrying the memory and the workspace block.
    expect(stable).toContain("integer cents");
    expect(stable).toContain(WORKSPACE);
    expect(hook.stablePreludeFor("run_b")).toBe(stable);

    const shared = commonPrefix(first, second);
    expect(shared).toContain(stable);
    expect(shared).not.toContain(OBJECTIVE_A);
    expect(first.indexOf(OBJECTIVE_A)).toBeGreaterThan(first.indexOf(stable) + stable.length);
    expect(second.indexOf(OBJECTIVE_B)).toBeGreaterThan(second.indexOf(stable) + stable.length);
    // Moved, not copied: the tier is in the request once.
    expect(occurrences(first, stable)).toBe(1);
  });

  it("puts the stable tier at the head of the system message, keeps the seat prompt's bytes after it, and leaves CONTEXT and VOLATILE after the objective", async () => {
    const { hook } = harness();
    const [system, user] = await renderRun(hook, "run_a", OBJECTIVE_A);
    const stable = hook.stablePreludeFor("run_a") ?? "";

    expect(system?.role).toBe("system");
    expect(system?.content).toBe(`${stable}\n\n${SEAT_SYSTEM}`);
    // The personality is VOLATILE: never the system prompt (improve/protected-prompt.ts).
    expect(system?.content).not.toContain(PERSONALITY);
    const text = user?.content ?? "";
    const objectiveAt = text.indexOf(OBJECTIVE_A);
    expect(objectiveAt).toBeGreaterThan(-1);
    expect(text.indexOf("## Fleet recall")).toBeGreaterThan(objectiveAt);
    expect(text.indexOf("## Conversation so far")).toBeGreaterThan(objectiveAt);
    expect(text.indexOf(PERSONALITY)).toBeGreaterThan(text.indexOf("## Conversation so far"));
    expect(text).not.toContain("## Company memory");
  });

  it("changes ORDER only: the rendered prompt carries the old layout's bytes, reordered", async () => {
    const { hook } = harness();
    const now = await renderRun(hook, "run_a", OBJECTIVE_A);
    // The layout before P2-7: the seat's own system prompt, and the whole injection after the pipeline's text.
    const before = await sendThroughApp({
      companyId: COMPANY,
      subtask: subtaskFor(OBJECTIVE_A),
      systemPrompt: SEAT_SYSTEM,
      dynamicPrompt: `${PIPELINE_TEXT}\n\n${hook.preludeFor("run_a", "engineer") ?? ""}`,
    });
    const lines = (messages: readonly Message[]) => messages.flatMap((m) => m.content.split("\n")).sort();

    expect(rendered(now)).not.toBe(rendered(before));
    expect(rendered(now).length).toBe(rendered(before).length);
    expect(lines(now)).toEqual(lines(before));
  });

  it("keeps the whole injection in dynamicPrompt for a seat input that has no system prompt to carry the tier", async () => {
    const { hook } = harness();
    const seen: Array<{ systemPrompt?: string; dynamicPrompt?: string }> = [];
    const seat = hook.wrapSeatModel(async (input: { companyId: string; subtask: { id: string; seat: string; objective: string }; systemPrompt?: string; dynamicPrompt?: string }) => {
      seen.push({ ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }), ...(input.dynamicPrompt === undefined ? {} : { dynamicPrompt: input.dynamicPrompt }) });
      return "done";
    });
    hook.runStarted({ runId: "run_a", companyId: COMPANY, objective: OBJECTIVE_A });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: OBJECTIVE_A }, dynamicPrompt: PIPELINE_TEXT });

    expect(seen[0]?.systemPrompt).toBeUndefined();
    expect(seen[0]?.dynamicPrompt).toBe(`${PIPELINE_TEXT}\n\n${hook.preludeFor("run_a", "engineer") ?? ""}`);
    expect(seen[0]?.dynamicPrompt).toContain("## Company memory");
  });
  it("with skill injection active, the stable tier is still the first bytes of the system prompt and the injected prelude follows it", async () => {
    const { hook } = harness();
    const store = new InMemoryImproveStore();
    await store.createDraft({
      id: "skill_engineer", companyId: COMPANY, agentId: "engineer", taskType: "general", kind: "skill", status: "live",
      content: "# Skill for engineer\nSENTINEL-SKILL: read the raw body before parsing a webhook.", contentHash: "h", triggers: [],
      createdAt: "2026-09-24T10:00:00.000Z", promotedAt: "2026-09-24T10:00:00.000Z", lastUsedAt: null, retiredAt: null,
    });
    const injector = createSkillInjector({ store, enabled: () => true });
    let sent: Message[] = [];
    // The production order (orchestrator/index.ts): the fleet hook outside, the improve injector inside it.
    const seat = hook.wrapSeatModel(
      injector.seatModel(async (input: SeatInput) => {
        sent = await sendThroughApp(input);
        return { output: {}, model: "recorder", tokens: 0, costCents: 0, fallback: false };
      }),
    );
    hook.runStarted({ runId: "run_a", companyId: COMPANY, objective: OBJECTIVE_A });
    await seat({ companyId: COMPANY, subtask: subtaskFor(OBJECTIVE_A), systemPrompt: SEAT_SYSTEM, dynamicPrompt: PIPELINE_TEXT });
    hook.runFinished("run_a");
    const stable = hook.stablePreludeFor("run_a") ?? "";
    const system = sent[0]?.content ?? "";

    expect(injector.appliedTo("step_1")).toBe(true);
    expect(system.startsWith(`${stable}\n\n`)).toBe(true);
    expect(system.indexOf(SKILL_PRELUDE_MARKER)).toBe(stable.length + 2);
    expect(system).toContain("SENTINEL-SKILL");
    expect(system.endsWith(`\n\n${SEAT_SYSTEM}`)).toBe(true);
  });

  it("two prompts that differ only in the stable tier have different dynamicPrompt bytes, so the app's analyst cache never reuses an answer across a memory change", async () => {
    const gateway: Gateway = await import("@/lib/model-gateway");
    gateway.clearModelGatewayCache();
    const { hook } = harness();
    const seen: SeatInput[] = [];
    let providerCalls = 0;
    const seat = hook.wrapSeatModel(async (input: SeatInput) => {
      seen.push(input);
      return gateway.executeSeatModel({
        ...input,
        createChatCompletion: async () => {
          providerCalls += 1;
          return { choices: [{ message: { content: '{"summary":"ok"}' } }] };
        },
      });
    });
    // The same analyst question twice; between the runs only the company memory (a STABLE block) changes.
    const ask = async (runId: string) => {
      hook.runStarted({ runId, companyId: COMPANY, objective: OBJECTIVE_A });
      await seat({ companyId: COMPANY, subtask: subtaskFor(OBJECTIVE_A, "analyst"), systemPrompt: SEAT_SYSTEM, dynamicPrompt: PIPELINE_TEXT });
      hook.runFinished(runId);
    };
    await ask("run_a");
    fs.appendFileSync(path.join(profileDir, "memories", "MEMORY.md"), "\n§\nRefunds are issued within 30 days.");
    await ask("run_b");
    const version = (runId: string) => `Stable tier version: ${createHash("sha256").update(hook.stablePreludeFor(runId) ?? "").digest("hex").slice(0, 12)}`;

    expect(hook.stablePreludeFor("run_b")).not.toBe(hook.stablePreludeFor("run_a"));
    expect(seen[1]?.systemPrompt).not.toBe(seen[0]?.systemPrompt);
    expect(seen[1]?.dynamicPrompt).not.toBe(seen[0]?.dynamicPrompt);
    expect(seen[0]?.dynamicPrompt).toContain(version("run_a"));
    expect(seen[1]?.dynamicPrompt).toContain(version("run_b"));
    expect(providerCalls).toBe(2);
  });
});
