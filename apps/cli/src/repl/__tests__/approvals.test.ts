/**
 * 3.8 — approval cards that block input until answered.
 *
 * Persistence across a real restart is proved separately, against the real bun:sqlite
 * store, in approvals.restart.test.ts. An in-memory double cannot prove durability.
 */

import { describe, it, expect } from "vitest";
import { createTheme, EMBER_SGR, sgrCodesIn } from "../../ui/index.js";
import { ApprovalGate, renderApprovalCard } from "../approvals.js";
import { MemoryStore, makeHarness } from "./harness.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";

const plain = createTheme("none");

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_a", at: "2026-09-12T00:00:00.000Z", ...extra } as OrcEvent;
}

describe("the approval card", () => {
  it("renders in ember, states the action, and offers both answers without emoji", () => {
    const colour = createTheme("truecolor");
    const card = renderApprovalCard(
      { id: "apr_1", action: "publish the post", reason: "high risk", agentRole: "marketing-writer" },
      colour,
      60,
    );
    const text = card.join("\n");
    expect(text).toContain("publish the post");
    expect(text).toContain("high risk");
    expect(text).toMatch(/\[y\]/);
    expect(text).toMatch(/\[n\]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(sgrCodesIn(text)).toContain(EMBER_SGR.truecolor);
    for (const line of card) expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(60);
  });
});

describe("the gate", () => {
  it("blocks while an approval is open and unblocks once answered", async () => {
    const gate = new ApprovalGate(new MemoryStore(), "cmp_g");
    expect(gate.blocking).toBe(false);
    const record = await gate.open({ action: "deploy", reason: "prod", agentRole: "eng-devops" });
    expect(gate.blocking).toBe(true);
    await gate.answer(record.id, "approved");
    expect(gate.blocking).toBe(false);
    expect(await gate.pending()).toHaveLength(0);
  });

  it("restores its blocking state from the store, which is what makes a restart work", async () => {
    const store = new MemoryStore();
    const first = new ApprovalGate(store, "cmp_g");
    await first.open({ action: "deploy", reason: "prod", agentRole: "eng-devops" });

    const second = new ApprovalGate(store, "cmp_g");
    expect(second.blocking).toBe(false); // nothing loaded yet
    await second.restore();
    expect(second.blocking).toBe(true);
    expect((await second.pending())[0]?.action).toBe("deploy");
  });
});

describe("an approval inside a live turn", () => {
  it("holds ordinary input until the approval is answered, then resumes", async () => {
    const h = makeHarness({
      events: [
        ev("run_start", { run: { objective: "ship it" } }),
        ev("step_start", { step: { id: "s1", title: "Deploy to prod", agentRole: "eng-devops" } }),
        ev("step_awaiting_approval", {
          step: { id: "s1", title: "Deploy to prod", agentRole: "eng-devops" },
          detail: "production deploy",
        }),
      ],
    });

    const turn = h.engine.submit("ship it");
    await h.emitted(3);
    await new Promise((r) => setTimeout(r, 5));

    expect(h.engine.awaitingApproval).toBe(true);
    expect(h.transcript().join("\n")).toContain("Deploy to prod");

    // Ordinary keystrokes are refused while the card is open…
    h.feed("hello");
    expect(h.engine.draft).toBe("");

    // …and y answers it.
    h.feed("y");
    await turn;
    expect(h.engine.awaitingApproval).toBe(false);
    expect(h.transcript().join("\n")).toMatch(/approved/i);
    expect(h.store.allApprovals()[0]?.status).toBe("approved");
  });

  it("records a rejection, in the store, when the answer is n", async () => {
    const h = makeHarness({
      events: [
        ev("step_awaiting_approval", {
          step: { id: "s1", title: "Deploy to prod", agentRole: "eng-devops" },
          detail: "production deploy",
        }),
      ],
    });
    const turn = h.engine.submit("ship it");
    await h.emitted(1);
    await new Promise((r) => setTimeout(r, 5));
    h.feed("n");
    await turn;
    expect(h.store.allApprovals()[0]?.status).toBe("rejected");
    expect(h.transcript().join("\n")).toMatch(/rejected/i);
  });
});

describe("the approval card in monochrome", () => {
  it("still distinguishes itself by glyph alone", () => {
    const card = renderApprovalCard(
      { id: "apr_1", action: "publish", reason: "risk", agentRole: "marketing-writer" },
      plain,
      60,
    ).join("\n");
    expect(card).not.toMatch(/\x1b\[/);
    expect(card).toContain("◆");
  });
});
