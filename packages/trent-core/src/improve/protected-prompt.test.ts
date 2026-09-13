/**
 * Item 6 — adopted from Hermes: the protected-prompt rule. No agent writes its own seat prompt.
 * Only a GEPA proposal that passed the executing gate may be staged; only a human may promote.
 */
import { describe, expect, it } from "vitest";

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
});
