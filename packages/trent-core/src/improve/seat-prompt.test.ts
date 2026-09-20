/**
 * The seat prompt the improve loop reflects on and the gate baselines against. A specialist's
 * prompt is the seat prompt plus the specialist prompt the app would run it with, which is the
 * V3 view (`getCatalogAgentV3`): the flagship overrides in `agent-catalog.ts` carry the only
 * `specialistPrompt` some specialists have, and the pre-V3 lookup never saw them (RA side
 * finding, `upgrade-agents-audit-2026-09-19.md` section 7).
 */
import { describe, expect, it } from "vitest";

import { getCatalogAgent, getCatalogAgentV3 } from "../agents/index.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { defaultSeatPromptProvider, seatRoleFor } from "./seat-prompt.js";

const COMPANY = "co_seat_prompt";

describe("seatRoleFor", () => {
  it("is the seat itself for a seat and the traced seat for a specialist", () => {
    expect(seatRoleFor("finance")).toBe("finance");
    expect(seatRoleFor("eng-code-reviewer", "engineer")).toBe("engineer");
    expect(seatRoleFor("eng-code-reviewer")).toBe("engineer");
  });
});

describe("defaultSeatPromptProvider", () => {
  it("layers the V3 specialist prompt on the seat prompt, so a flagship override reaches the loop", async () => {
    // The premise: this specialist's prompt exists only in the V3 overrides.
    expect(getCatalogAgent("eng-code-reviewer")?.specialistPrompt).toBeUndefined();
    const v3 = getCatalogAgentV3("eng-code-reviewer")?.specialistPrompt ?? "";
    expect(v3).toContain("Specialty: Code Review.");

    const provider = defaultSeatPromptProvider(new InMemoryImproveStore(), COMPANY, () => "engineer");
    const specialist = await provider("eng-code-reviewer");
    const seat = await provider("engineer");

    expect(seat.length).toBeGreaterThan(0);
    expect(specialist.startsWith(seat)).toBe(true);
    expect(specialist).toContain(v3);
  });

  it("gives a specialist with no prompt of its own exactly the seat prompt", async () => {
    const provider = defaultSeatPromptProvider(new InMemoryImproveStore(), COMPANY, () => "engineer");
    expect(getCatalogAgentV3("eng-ai-engineer")?.specialistPrompt).toBeUndefined();
    expect(await provider("eng-ai-engineer")).toBe(await provider("engineer"));
  });
});
