/**
 * Item 6 — adopted from Hermes: the protected-prompt rule. No agent writes its own seat prompt.
 * Only a GEPA proposal that passed the executing gate may be staged; only a human may promote.
 */
import { describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFleetMemoryHook } from "../fleet-memory/orchestrator-hook.js";
import { InMemoryFleetSource } from "../fleet-memory/source.js";
import { BUILTIN_PERSONALITIES } from "../personalities/built-in.js";
import { createMemoryAdapter } from "../tools/memory/index.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { ProtectedPromptError, promoteDraft, readSeatPrompt, stagePromptProposal, writeSeatPrompt } from "./index.js";

const COMPANY = "co_prompt";
const BASE = "base seat prompt";

describe("protected seat prompt", () => {
  it("a direct write to a seat prompt from a tool or agent path is refused", async () => {
    const store = new InMemoryImproveStore();
    for (const actor of ["tool", "agent", "engineer", "skill"] as const) {
      await expect(
        writeSeatPrompt(store, { companyId: COMPANY, agentId: "engineer", content: "hijacked", actor }),
      ).rejects.toBeInstanceOf(ProtectedPromptError);
    }
    expect(await readSeatPrompt(store, COMPANY, "engineer", BASE)).toBe(BASE);
    expect(await store.listDrafts(COMPANY, { kind: "prompt" })).toEqual([]);
  });

  it("a proposal may be staged only when its iteration passed the executing gate", async () => {
    const store = new InMemoryImproveStore();
    await store.appendIteration({
      id: "iter_blocked",
      companyId: COMPANY,
      agentId: "engineer",
      taskType: "__seat_prompt__",
      candidateId: "gepa_a",
      candidateKind: "prompt",
      score: 0.4,
      delta: -0.2,
      decision: "rejected",
      triggers: [],
      blockedBy: "regression",
      inputHash: null,
      verdicts: null,
      createdAt: "t",
    });
    await expect(
      stagePromptProposal(store, { companyId: COMPANY, agentId: "engineer", iterationId: "iter_blocked", proposedPrompt: "v2" }),
    ).rejects.toBeInstanceOf(ProtectedPromptError);

    await store.appendIteration({
      id: "iter_ok",
      companyId: COMPANY,
      agentId: "engineer",
      taskType: "__seat_prompt__",
      candidateId: "gepa_b",
      candidateKind: "prompt",
      score: 0.9,
      delta: 0.1,
      decision: "pending_approval",
      triggers: [],
      blockedBy: null,
      inputHash: null,
      verdicts: { stage: "judge" },
      createdAt: "t",
    });
    const staged = await stagePromptProposal(store, { companyId: COMPANY, agentId: "engineer", iterationId: "iter_ok", proposedPrompt: "v2" });
    expect(staged.status).toBe("quarantine");
    expect(staged.kind).toBe("prompt");
    // Staged is not live: the seat still reads its base prompt.
    expect(await readSeatPrompt(store, COMPANY, "engineer", BASE)).toBe(BASE);
    expect((await store.listLedger(COMPANY, { artifactId: staged.id })).map((l) => l.action)).toEqual(["stage"]);
  });

  it("only an explicit human command promotes a staged prompt; then the seat reads it", async () => {
    const store = new InMemoryImproveStore();
    await store.appendIteration({
      id: "iter_ok",
      companyId: COMPANY,
      agentId: "engineer",
      taskType: "__seat_prompt__",
      candidateId: "gepa_b",
      candidateKind: "prompt",
      score: 0.9,
      delta: 0.1,
      decision: "pending_approval",
      triggers: [],
      blockedBy: null,
      inputHash: null,
      verdicts: null,
      createdAt: "t",
    });
    const staged = await stagePromptProposal(store, { companyId: COMPANY, agentId: "engineer", iterationId: "iter_ok", proposedPrompt: "v2" });
    await expect(promoteDraft(store, staged.id, { actor: "agent" })).rejects.toBeInstanceOf(ProtectedPromptError);
    await expect(promoteDraft(store, staged.id, { actor: "sweep" })).rejects.toBeInstanceOf(ProtectedPromptError);
    await promoteDraft(store, staged.id, { actor: "human" });
    expect(await readSeatPrompt(store, COMPANY, "engineer", BASE)).toBe("v2");
  });

  /**
   * The rule the header states: `config.personality` may never become part of the seat prompt the
   * improve loop protects. It is not "no personality anywhere" — a personality with no path to a
   * model is a setting that does nothing — so the assertion is two-sided: absent from the protected
   * prompt, present in the VOLATILE tier of the wrapper's injection, which no proposal can stage.
   */
  it("a personality never reaches the protected seat prompt; the volatile tier is its only path", async () => {
    const store = new InMemoryImproveStore();
    const suffix = BUILTIN_PERSONALITIES.pirate!.systemPromptSuffix;
    expect(await readSeatPrompt(store, COMPANY, "engineer", BASE)).toBe(BASE);
    expect(await readSeatPrompt(store, COMPANY, "engineer", BASE)).not.toContain(suffix);

    const staged = await stagePromptProposal(store, {
      companyId: COMPANY,
      agentId: "engineer",
      iterationId: await gatedIteration(store),
      proposedPrompt: "v2 of the seat prompt",
    });
    await promoteDraft(store, staged.id, { actor: "human" });
    expect(await readSeatPrompt(store, COMPANY, "engineer", BASE)).not.toContain(suffix);

    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-personality-"));
    try {
      const hook = createFleetMemoryHook({
        source: new InMemoryFleetSource(),
        memory: createMemoryAdapter({ profileDir }),
        personalitySuffix: suffix,
      });
      let injected = "";
      const seat = hook.wrapSeatModel(async (input: { subtask: { id: string; seat: string; objective: string }; dynamicPrompt?: string }) => {
        injected = input.dynamicPrompt ?? "";
        return {};
      });
      hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "ship it" });
      await seat({ subtask: { id: "s1", seat: "engineer", objective: "ship it" } });
      expect(injected).toContain(suffix.trim());
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

/** An iteration that passed the executing gate, so a proposal may be staged against it. */
async function gatedIteration(store: InMemoryImproveStore): Promise<string> {
  await store.appendIteration({
    id: "iter_personality",
    companyId: COMPANY,
    agentId: "engineer",
    taskType: "__seat_prompt__",
    candidateId: "gepa_p",
    candidateKind: "prompt",
    score: 0.9,
    delta: 0.1,
    decision: "pending_approval",
    triggers: [],
    blockedBy: null,
    inputHash: null,
    verdicts: null,
    createdAt: "t",
  });
  return "iter_personality";
}
