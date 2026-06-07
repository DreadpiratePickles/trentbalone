/**
 * Autoresearch read helper — shared by the Workbench page (server component)
 * and the autoresearch API route.
 *
 * Joins the structural iteration log (which carries taskType / candidateKind /
 * approvalId) with the human-facing approval queue (which carries the preview
 * content + reason) so the UI can render a Pending-review list and a full
 * iteration-history timeline from one call.
 *
 * No-DB / dev safe: when DATABASE_URL is unset we return empty collections
 * rather than touching Prisma.
 */

import type { SelfImprovementIteration } from "@/lib/self-improvement/iteration-log";
import { PrismaIterationLog } from "@/lib/self-improvement/iteration-log.prisma";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

/** Approval actions emitted by the self-improvement loop. */
const SELF_IMPROVEMENT_ACTIONS = new Set(["skill.review", "skill.promotion", "prompt.promotion"]);

export type AutoresearchPending = {
  approvalId: string;
  taskType: string;
  candidateKind?: string;
  reason: string;
  previewContent?: string;
  createdAt: string;
};

export type AutoresearchView = {
  iterations: SelfImprovementIteration[];
  pending: AutoresearchPending[];
};

/**
 * Load the autoresearch view for a company: full iteration history + the
 * subset of pending approvals that belong to the self-improvement loop,
 * enriched with taskType/candidateKind recovered from the matching iteration.
 */
export async function loadAutoresearchView(companyId: string): Promise<AutoresearchView> {
  if (!process.env.DATABASE_URL) {
    return { iterations: [], pending: [] };
  }

  return withRlsContext(companyId, async () => {
    const iterations = await new PrismaIterationLog().list(companyId);
    const approvals = await store.listApprovals(companyId);

    const byApprovalId = new Map<string, SelfImprovementIteration>();
    for (const iter of iterations) {
      if (iter.approvalId) byApprovalId.set(iter.approvalId, iter);
    }

    const pending: AutoresearchPending[] = approvals
      .filter((a) => a.status === "pending" && SELF_IMPROVEMENT_ACTIONS.has(a.action))
      .map((a) => {
        const iter = byApprovalId.get(a.id);
        return {
          approvalId: a.id,
          taskType: iter?.taskType ?? a.action,
          candidateKind: iter?.candidateKind,
          reason: a.reason,
          previewContent: a.previewContent,
          createdAt: a.createdAt,
        };
      });

    return { iterations, pending };
  });
}
