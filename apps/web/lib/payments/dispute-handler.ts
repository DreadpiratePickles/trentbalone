import { store } from "@/lib/store";
import type { Approval } from "@/lib/types";

/**
 * Escalates a payment dispute to the approvals queue for manual resolution.
 */
export async function escalateDispute(
  companyId: string,
  txHash: string,
  amountCents: number,
  counterpartyWallet: string
): Promise<Approval> {
  const previewContent = JSON.stringify({
    riskClass: "irreversible",
    txHash,
    amountCents,
    counterpartyWallet,
    resolutionOptions: [
      "mark_as_verified",
      "initiate_manual_off_chain_refund",
      "cancel_in_internal_logs",
    ],
  });

  return store.createApproval({
    companyId,
    action: "resolve_dispute",
    reason: `Dispute for transaction: ${txHash}`,
    previewKind: "generic",
    previewContent,
  });
}
