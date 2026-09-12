import { describe, expect, it } from "vitest";
import { evaluateDeliverability } from "./deliverability";
import { classifyReply, shouldPauseForHuman } from "./replies";
import { nextSequenceStep } from "./sequences";

describe("sequences, replies, and deliverability", () => {
  it("schedules drip steps with variants and exits on reply or conversion", () => {
    const exit = nextSequenceStep({
      startedAt: "2026-05-29T10:00:00.000Z",
      now: "2026-05-30T10:01:00.000Z",
      replied: true,
      converted: false,
      steps: [{ id: "s1", delayHours: 24, variant: "A" }],
    });
    expect(exit.status).toBe("exited");
    if (exit.status !== "exited") throw new Error("Expected sequence to exit after reply");
    expect(exit.reason).toBe("reply_detected");

    const next = nextSequenceStep({
      startedAt: "2026-05-29T10:00:00.000Z",
      now: "2026-05-30T10:01:00.000Z",
      replied: false,
      converted: false,
      steps: [{ id: "s1", delayHours: 24, variant: "B" }],
    });
    if (next.status !== "ready") throw new Error("Expected sequence step to be ready");
    expect(next.step.variant).toBe("B");
  });

  it("threads replies, detects sentiment, and pauses negative or buying-intent replies", () => {
    const reply = classifyReply({
      messageId: "m_1",
      inReplyTo: "m_0",
      body: "Not interested, please stop.",
    });
    expect(reply.threadKey).toBe("m_0");
    expect(reply.sentiment).toBe("negative");
    expect(shouldPauseForHuman(reply)).toBe(true);
  });

  it("reports SPF, DKIM, DMARC, and Postmaster readiness", () => {
    const result = evaluateDeliverability({
      spf: true,
      dkim: true,
      dmarc: false,
      postmasterConnected: false,
    });
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(["dmarc", "postmaster_tools"]);
  });
});
