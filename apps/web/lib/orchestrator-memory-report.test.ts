import { describe, expect, it } from "vitest";
import { buildContentMissionFallbackPlan } from "@/lib/content-mission";
import { buildRunMarkdownReport, type OrchestrationRun } from "@/lib/orchestrator";

describe("orchestrator memory report", () => {
  it("persists content mission approval packet and external action ledger evidence", () => {
    const plan = buildContentMissionFallbackPlan("Research viral ideas, create videos, publish to TikTok and X, reply to DMs, and run Meta ads.");
    const run: OrchestrationRun = {
      id: "orc_memory",
      companyId: "co_1",
      objective: plan.objective,
      status: "completed",
      plan,
      startedAt: "2026-06-04T12:00:00.000Z",
      completedAt: "2026-06-04T12:05:00.000Z",
      trigger: "manual",
      steps: [
        {
          ...plan.steps[0],
          status: "completed",
          output: "Analyst captured viral sources, competitor hooks, and audience pain.",
        },
        {
          ...plan.steps.find((step) => step.agentRole === "content")!,
          status: "completed",
          output: "Content drafted scripts, captions, CTAs, and video prompts.",
        },
        {
          ...plan.steps.find((step) => step.agentRole === "growth" && /paid ad/i.test(step.title))!,
          status: "blocked",
          output: "Ads remain draft-only.",
          toolCalls: [
            {
              adapter: "platform_readiness",
              action: "check",
              status: "needs_approval",
              summary: "Platform readiness blocked external action: tiktok social account is not connected; meta payment status is needs_payment_method",
            },
          ],
        },
      ],
      summary: "CEO summary intentionally short.",
    };

    const markdown = buildRunMarkdownReport(run);

    expect(markdown).toContain("## Content Mission Evidence");
    expect(markdown).toContain("## CEO Content Approval Packet");
    expect(markdown).toContain("### External Action Ledger");
    expect(markdown).toContain("public_publish");
    expect(markdown).toContain("comment_or_dm_reply");
    expect(markdown).toContain("paid_spend_or_boost");
    expect(markdown).toContain("platform_auth_or_scope_gap");
    expect(markdown).toContain("Analyst captured viral sources");
    expect(markdown).toContain("Content drafted scripts");
  });
});
