import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import type { Document, Task, ToolCallRecord } from "@/lib/types";

const GMAIL_SEND_APPROVAL_ACTION = "gmail.send";

export type GmailDraftInput = {
  to?: string;
  subject?: string;
  body?: string;
};

async function findGmailSendApproval(task: Task) {
  if (task.approvalId) {
    const linked = await store.getApproval(task.approvalId);
    if (linked?.action === GMAIL_SEND_APPROVAL_ACTION) return linked;
  }

  const approvals = await store.listApprovals(task.companyId);
  return approvals.find(
    (approval) => approval.taskId === task.id && approval.action === GMAIL_SEND_APPROVAL_ACTION
  );
}

async function ensureGmailSendApproval(task: Task) {
  const existing = await findGmailSendApproval(task);
  if (existing?.status === "approved") return { approved: true, approvalId: existing.id };

  if (existing?.status === "rejected") {
    await store.updateTask(task.id, { status: "blocked", approvalId: existing.id });
    return { approved: false, approvalId: existing.id, rejected: true };
  }

  if (existing?.status === "pending") {
    await store.updateTask(task.id, { status: "waiting_approval", approvalId: existing.id });
    return { approved: false, approvalId: existing.id };
  }

  const approval = await store.createApproval({
    companyId: task.companyId,
    taskId: task.id,
    action: GMAIL_SEND_APPROVAL_ACTION,
    reason: `Approve sending the Gmail draft for task "${task.title}".`
  });
  await store.updateTask(task.id, { status: "waiting_approval", approvalId: approval.id });
  return { approved: false, approvalId: approval.id };
}

export async function createGmailDraftForTask(
  task: Task,
  input: GmailDraftInput = {}
): Promise<Document> {
  const subject = input.subject?.trim() || task.title;
  const to = input.to?.trim() || "recipient@example.com";
  const body =
    input.body?.trim() ||
    [
      task.prompt,
      "",
      "Drafted by Trent. Human approval is required before this can be sent."
    ].join("\n");

  const document = await store.createDocument({
    companyId: task.companyId,
    type: "email_draft",
    title: `Gmail draft: ${subject}`,
    content: [`To: ${to}`, `Subject: ${subject}`, "", body].join("\n"),
    source: "gmail_mock",
    version: 1
  });

  await store.addUsage({
    companyId: task.companyId,
    category: "infra",
    description: "Gmail draft creation",
    amountCents: 0,
    metadata: { taskId: task.id, documentId: document.id, at: nowIso() }
  });

  return document;
}

export async function sendGmailDraftForTask(task: Task): Promise<ToolCallRecord & { approvalId?: string }> {
  const approval = await ensureGmailSendApproval(task);
  if (!approval.approved) {
    return {
      adapter: "Gmail",
      action: "send",
      status: "needs_approval",
      summary: approval.rejected
        ? "Gmail send was rejected and the task is blocked."
        : "Gmail send requires approval before Trent can send or simulate sending email.",
      approvalId: approval.approvalId
    };
  }

  await store.updateTask(task.id, { status: "running" });
  await store.createDocument({
    companyId: task.companyId,
    type: "agent_note",
    title: `Mock Gmail send: ${task.title}`,
    content:
      "Gmail remains mocked. Trent recorded that this approved email would be sent through the Gmail provider once OAuth/send credentials are production-ready.",
    source: "gmail_mock",
    version: 1
  });
  await store.addUsage({
    companyId: task.companyId,
    category: "infra",
    description: "Mock Gmail send",
    amountCents: 0,
    metadata: { taskId: task.id, at: nowIso(), mocked: true }
  });
  await store.updateTask(task.id, { status: "completed" });

  return {
    adapter: "Gmail",
    action: "send",
    status: "mocked",
    summary: "Approved Gmail send recorded in mocked mode; no email was sent."
  };
}
