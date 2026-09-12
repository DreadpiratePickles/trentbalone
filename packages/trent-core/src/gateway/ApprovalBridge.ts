import crypto from "node:crypto";
import EventEmitter from "node:events";

export interface ApprovalRequest {
  id: string;
  agentId: string;
  action: string;
  details: Record<string, unknown>;
  budgetImpact?: number;
  estimatedDurationMs?: number;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export class ApprovalBridge extends EventEmitter {
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();

  public createApprovalRequest(
    agentId: string,
    action: string,
    details: Record<string, unknown>,
    options?: { budgetImpact?: number; estimatedDurationMs?: number }
  ): ApprovalRequest {
    const id = `appr_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const request: ApprovalRequest = {
      id,
      agentId,
      action,
      details,
      budgetImpact: options?.budgetImpact,
      estimatedDurationMs: options?.estimatedDurationMs,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.pendingApprovals.set(id, request);
    this.emit("approval_requested", request);
    return request;
  }

  public getApproval(id: string): ApprovalRequest | undefined {
    return this.pendingApprovals.get(id);
  }

  public listPending(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).filter((a) => a.status === "pending");
  }

  public decide(id: string, decision: "approved" | "denied", decidedBy = "user"): ApprovalRequest {
    const req = this.pendingApprovals.get(id);
    if (!req) {
      throw new Error(`Approval request "${id}" not found.`);
    }

    if (req.status !== "pending") {
      throw new Error(`Approval request "${id}" is already ${req.status}.`);
    }

    req.status = decision;
    req.decidedAt = new Date().toISOString();
    req.decidedBy = decidedBy;

    this.emit("approval_decided", req);
    return req;
  }

  public formatTelegramCard(request: ApprovalRequest): {
    text: string;
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  } {
    const text = [
      `⚠️ *APPROVAL REQUIRED*`,
      `*Agent:* [${request.agentId}]`,
      `*Action:* ${request.action}`,
      `*Details:* ${JSON.stringify(request.details)}`,
      request.budgetImpact ? `*Budget Impact:* $${request.budgetImpact.toFixed(2)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const inline_keyboard = [
      [
        { text: "✅ Approve", callback_data: `approve_${request.id}` },
        { text: "❌ Deny", callback_data: `deny_${request.id}` },
      ],
    ];

    return { text, inline_keyboard };
  }

  public formatSlackCard(request: ApprovalRequest): Record<string, unknown> {
    return {
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*⚠️ APPROVAL REQUIRED*\n*Agent:* ${request.agentId}\n*Action:* ${request.action}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve" },
              style: "primary",
              value: `approve_${request.id}`,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Deny" },
              style: "danger",
              value: `deny_${request.id}`,
            },
          ],
        },
      ],
    };
  }
}
