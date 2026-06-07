import { describe, expect, it } from "vitest";
import { createGmailDraftForTask, sendGmailDraftForTask } from "@/lib/gmail";
import { store } from "@/lib/store";

describe("Gmail mocked workflow", () => {
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

  it("creates an approval interrupt before mocked Gmail send", async () => {
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

  it("records mocked Gmail send after approval", async () => {
    const company = await store.createCompany({
      name: "Gmail Send Co",
      brief: { vision: "Mock approved send" }
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
      reason: "Approve mocked Gmail send."
    });
    await store.resolveApproval(approval.id, "approved");
    await store.updateTask(task.id, { approvalId: approval.id });

    const result = await sendGmailDraftForTask(task);
    expect(result.status).toBe("mocked");
    expect((await store.getTask(task.id))?.status).toBe("completed");
  });
});
