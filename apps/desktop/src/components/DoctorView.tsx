import React from "react";
import { Activity, CheckCircle2, AlertTriangle, XCircle, Wrench, RefreshCw } from "lucide-react";
import type { DoctorCheckItem } from "../types.js";

interface DoctorViewProps {
  checks: DoctorCheckItem[];
  isRunning: boolean;
  onRunDiagnostics: () => void;
  onRunFixes: () => void;
}

export const DoctorView: React.FC<DoctorViewProps> = ({
  checks,
  isRunning,
  onRunDiagnostics,
  onRunFixes,
}) => {
  const passed = checks.filter((c) => c.status === "ok").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const errors = checks.filter((c) => c.status === "error").length;

  return (
    <div className="flex-1 p-6 bg-[#0F1117] h-[calc(100vh-3.5rem)] overflow-y-auto select-none">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Doctor Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#262B3B]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Activity className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                Trent Doctor — System Diagnostics
              </h2>
              <p className="text-xs text-gray-400">
                Automated health checks across config, credentials, fleet agents, sandboxes, and platform adapters.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onRunDiagnostics}
              disabled={isRunning}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1A1D27] hover:bg-[#232736] border border-[#262B3B] text-xs font-semibold text-cyan-400 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRunning ? "animate-spin" : ""}`} />
              <span>Run Checks</span>
            </button>
            {(warnings > 0 || errors > 0) && (
              <button
                onClick={onRunFixes}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white transition-colors shadow-sm"
              >
                <Wrench className="w-3.5 h-3.5" />
                <span>Fix Safe Issues</span>
              </button>
            )}
          </div>
        </div>

        {/* Scoreboard Cards */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-[#161922] border border-[#262B3B] rounded-xl p-4 text-center">
            <div className="text-2xl font-black text-emerald-400 font-mono">{passed}</div>
            <div className="text-xs text-gray-400 font-medium mt-0.5">Passed Checks</div>
          </div>
          <div className="bg-[#161922] border border-[#262B3B] rounded-xl p-4 text-center">
            <div className="text-2xl font-black text-amber-400 font-mono">{warnings}</div>
            <div className="text-xs text-gray-400 font-medium mt-0.5">Warnings</div>
          </div>
          <div className="bg-[#161922] border border-[#262B3B] rounded-xl p-4 text-center">
            <div className="text-2xl font-black text-red-400 font-mono">{errors}</div>
            <div className="text-xs text-gray-400 font-medium mt-0.5">Errors</div>
          </div>
        </div>

        {/* Check Items List */}
        <div className="space-y-2.5">
          {checks.map((check) => {
            let statusIcon = <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
            let statusClass = "border-emerald-500/20 bg-emerald-500/5";

            if (check.status === "warn") {
              statusIcon = <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />;
              statusClass = "border-amber-500/30 bg-amber-500/5";
            } else if (check.status === "error") {
              statusIcon = <XCircle className="w-4 h-4 text-red-400 shrink-0" />;
              statusClass = "border-red-500/30 bg-red-500/5";
            }

            return (
              <div
                key={check.id}
                className={`p-3.5 rounded-xl border ${statusClass} bg-[#161922] flex items-start gap-3 transition-colors`}
              >
                {statusIcon}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-xs font-bold text-white uppercase font-mono tracking-wider">
                      {check.category}
                    </span>
                    {check.autoFixable && (
                      <span className="text-[10px] font-mono text-purple-400 bg-purple-500/10 px-1.5 py-0.2 rounded border border-purple-500/20">
                        Auto-Fixable
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-300 leading-relaxed">{check.message}</p>
                  {check.fixHint && (
                    <p className="text-[11px] text-gray-400 mt-1 italic">
                      ↳ Hint: {check.fixHint}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
