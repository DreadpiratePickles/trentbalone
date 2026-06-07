/**
 * StoreApprovalSink — adapter from the self-improvement `ApprovalSink` contract
 * onto the real company approval queue (`store.createApproval`).
 *
 * Kept tiny on purpose: every call is wrapped in `withRlsContext` so RLS fires on
 * Postgres, and the result is narrowed to the `{ id }` shape the engine expects.
 */

import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import type { ApprovalPreviewKind } from "@/lib/types";
import type { ApprovalSink } from "@/lib/self-improvement/promotion";

export class StoreApprovalSink implements ApprovalSink {
  async create(input: {
    companyId: string;
    action: string;
    reason: string;
    previewContent?: string;
    previewKind?: string;
  }): Promise<{ id: string }> {
    const approval = await withRlsContext(input.companyId, () =>
      store.createApproval({
        companyId: input.companyId,
        action: input.action,
        reason: input.reason,
        previewContent: input.previewContent,
        previewKind: input.previewKind as ApprovalPreviewKind | undefined,
      }),
    );
    return { id: approval.id };
  }
}
