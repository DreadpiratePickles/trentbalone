import { useState, useEffect } from "react";
import { ApprovalBridge, type ApprovalRequest } from "@trent/core";

export function useApprovals(approvalBridge: ApprovalBridge) {
  const [pending, setPending] = useState<ApprovalRequest[]>(() => approvalBridge.listPending());

  useEffect(() => {
    const update = () => setPending(approvalBridge.listPending());
    approvalBridge.on("approval_requested", update);
    approvalBridge.on("approval_decided", update);

    return () => {
      approvalBridge.off("approval_requested", update);
      approvalBridge.off("approval_decided", update);
    };
  }, [approvalBridge]);

  return {
    pending,
    approve: (id: string) => approvalBridge.decide(id, "approved"),
    deny: (id: string) => approvalBridge.decide(id, "denied"),
  };
}
