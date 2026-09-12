import React from "react";
import { ShieldAlert, CheckCircle, XCircle, Terminal, FileText, AlertOctagon } from "lucide-react";
import type { ApprovalRequest } from "../types.js";

interface ApprovalModalProps {
  approvals: ApprovalRequest[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}

export const ApprovalModal: React.FC<ApprovalModalProps> = ({
  approvals,
  onApprove,
  onDeny,
}) => {
  const getRiskColor = (risk: ApprovalRequest["riskLevel"]) => {
    switch (risk) {
      case "critical":
        return "text-red-400 bg-red-500/20 border-red-500/40";
      case "high":
        return "text-amber-400 bg-amber-500/20 border-amber-500/40";
      case "medium":
        return "text-yellow-400 bg-yellow-500/20 border-yellow-500/40";
      default:
        return "text-blue-400 bg-blue-500/20 border-blue-500/40";
    }
  };

  return (
    <div className="flex-1 p-6 bg-[#0F1117] h-[calc(100vh-3.5rem)] overflow-y-auto select-none">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between pb-4 border-b border-[#262B3B]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Autonomous Action Approvals</h2>
              <p className="text-xs text-gray-400">
                Co-founder agents require human-in-the-loop sign-off for sensitive operations.
              </p>
            </div>
          </div>
          <span className="text-xs font-mono px-2.5 py-1 rounded bg-[#1A1D27] text-gray-300 border border-[#262B3B]">
            {approvals.length} pending
          </span>
        </div>

        {approvals.length === 0 ? (
          <div className="text-center py-16 bg-[#161922] rounded-xl border border-[#262B3B]">
            <CheckCircle className="w-10 h-10 text-emerald-400 mx-auto mb-2 opacity-80" />
            <h3 className="text-sm font-semibold text-white">Zero Pending Approvals</h3>
            <p className="text-xs text-gray-400 mt-1">All agent tasks are operating within normal autonomy policies.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {approvals.map((req) => (
              <div
                key={req.id}
                className="bg-[#161922] border border-[#262B3B] rounded-xl p-5 space-y-3 shadow-lg"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-purple-400 capitalize">[{req.agent}]</span>
                    <span className="text-sm font-semibold text-white">{req.action}</span>
                  </div>
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${getRiskColor(
                      req.riskLevel
                    )}`}
                  >
                    {req.riskLevel} Risk
                  </span>
                </div>

                <p className="text-xs text-gray-300">{req.description}</p>

                {req.command && (
                  <div className="p-2.5 rounded-lg bg-[#0F1117] border border-[#262B3B] font-mono text-xs text-cyan-300 flex items-center gap-2 overflow-x-auto">
                    <Terminal className="w-4 h-4 text-gray-500 shrink-0" />
                    <code>{req.command}</code>
                  </div>
                )}

                {req.targetFile && (
                  <div className="p-2 rounded bg-[#0F1117] border border-[#262B3B] font-mono text-xs text-gray-400 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-amber-400" />
                    <span>Target: {req.targetFile}</span>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 border-t border-[#262B3B]/60 text-xs">
                  <span className="text-[11px] text-gray-500 font-mono">
                    Requested at {req.requestedAt} · Estimated: ${req.costEstimated?.toFixed(2) || "0.00"}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onDeny(req.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1A1D27] hover:bg-red-500/20 text-gray-300 hover:text-red-400 border border-[#262B3B] transition-colors"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>Deny</span>
                    </button>
                    <button
                      onClick={() => onApprove(req.id)}
                      className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition-colors shadow-sm"
                    >
                      <CheckCircle className="w-4 h-4" />
                      <span>Approve</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
