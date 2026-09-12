import { describe, expect, it } from "vitest";
import { createGmailDraftForTask, sendGmailDraftForTask } from "@/lib/gmail";
import { store } from "@/lib/store";

describe("Gmail workflow", () => {
  it("creates a Gmail draft document without sending", async () => {
    const company = await store.createCompany({
      name: "Gmail Draft Co",
      brief: { vision: "Draft email safely" }
    });
    const task = await store.createTask({
      companyId: company.id,
      title: "Draft onboarding email",
      prompt: "Welcome a new user.",
      status: "queued",
      priority: "medium",
      agentRole: "content",
      tags: ["gmail"]
    });

    const draft = await createGmailDraftForTask(task, {
      to: "founder@example.com",
      subject: "Welcome",
      body: "Glad you are here."
    });

    expect(draft.type).toBe("email_draft");
    expect(draft.content).toContain("To: founder@example.com");
  });

  it("creates an approval interrupt before Gmail send", async () => {
    const company = await store.createCompany({
      name: "Gmail Approval Co",
      brief: { vision: "Require email approval" }
    });
    const task = await store.createTask({
      companyId: company.id,
      title: "Send customer email",
      prompt: "Send only after approval.",
      status: "queued",
      priority: "high",
      agentRole: "content",
      tags: ["gmail"]
    });

    const result = await sendGmailDraftForTask(task);
    const updated = await store.getTask(task.id);

    expect(result.status).toBe("needs_approval");
    expect(updated?.status).toBe("waiting_approval");
    expect(updated?.approvalId).toBeDefined();
  });

  it("fails approved Gmail send when no send provider is configured", async () => {
    const company = await store.createCompany({
      name: "Gmail Send Co",
      brief: { vision: "No fake approved send" }
    });
    const task = await store.createTask({
      companyId: company.id,
      title: "Send approved email",
      prompt: "Already approved.",
      status: "queued",
      priority: "high",
      agentRole: "content",
      tags: ["gmail"]
    });
    const approval = await store.createApproval({
      companyId: company.id,
      taskId: task.id,
      action: "gmail.send",
      reason: "Approve Gmail send."
    });
    await store.resolveApproval(approval.id, "approved");
    await store.updateTask(task.id, { approvalId: approval.id });

    const result = await sendGmailDraftForTask(task);
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/provider is not configured/i);
    expect(result.summary).not.toMatch(/mock/i);
    expect((await store.getTask(task.id))?.status).toBe("failed");
  });
});
