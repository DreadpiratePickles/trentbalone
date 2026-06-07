import { describe, expect, it, vi } from "vitest";
import type { ToolAdapter } from "@/lib/tools";
import {
  checkExternalSendOutputGuardrail,
  executeExternalActionWithGuardrails,
  isExternalSendAction,
} from "@/lib/external-action-guardrails";

describe("external-action guardrails", () => {
  it("detects external send actions", () => {
    expect(isExternalSendAction("send launch email")).toBe(true);
    expect(isExternalSendAction("publish to social")).toBe(true);
    expect(isExternalSendAction("read metrics")).toBe(false);
  });

  it("blocks a policy-violating send via output guardrail even when approval was skipped", async () => {
    const adapter: ToolAdapter = {
      name: "Email",
      scopes: ["send"],
      async healthCheck() { return "mocked"; },
      estimateCost() { return 0; },
      requiresApproval() { return true; },
      async execute(_action, payload) {
        return {
          adapter: "Email",
          action: "send launch email",
          status: "completed",
          summary: typeof payload.body === "string" ? payload.body : "sent",
        };
      },
    };

    const violation = checkExternalSendOutputGuardrail({
      action: "send launch email",
      payload: { body: "Guaranteed 100% returns — wire transfer today!" },
    });
    expect(violation.passed).toBe(false);
    expect(violation.tripwire).toBe("policy_violation");

    const record = await executeExternalActionWithGuardrails({
      adapter,
      action: "send launch email",
      payload: { body: "Guaranteed 100% returns — wire transfer today!" },
      approvalGranted: true,
    });
    expect(record.status).toBe("blocked");
    expect(record.summary).toMatch(/policy/i);
  });

  it("runs guardrail checks in parallel with execution for allowed sends", async () => {
    const executeSpy = vi.fn(async () => ({
      adapter: "Email",
      action: "send newsletter",
      status: "completed" as const,
      summary: "Newsletter queued",
    }));
    const adapter: ToolAdapter = {
      name: "Email",
      scopes: ["send"],
      async healthCheck() { return "mocked"; },
      estimateCost() { return 0; },
      requiresApproval() { return true; },
      execute: executeSpy,
    };

    const startedAt = Date.now();
    const record = await executeExternalActionWithGuardrails({
      adapter,
      action: "send newsletter",
      payload: { body: "Weekly product update for existing customers." },
      approvalGranted: true,
    });
    expect(record.status).toBe("completed");
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
