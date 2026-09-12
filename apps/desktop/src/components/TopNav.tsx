import React from "react";
import {
  MessageSquare,
  ShieldAlert,
  Users,
  Activity,
  Cpu,
  Network,
  BookOpen,
  Terminal,
  HeartPulse,
  Settings,
  Zap,
} from "lucide-react";
import type { TabType, BudgetState } from "../types.js";

interface TopNavProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  pendingApprovalsCount: number;
  budget: BudgetState;
  activeModel: string;
  activeProvider: string;
  doctorHealthy: boolean;
}

export const TopNav: React.FC<TopNavProps> = ({
  activeTab,
  onTabChange,
  pendingApprovalsCount,
  budget,
  activeModel,
  activeProvider,
  doctorHealthy,
}) => {
  const tabs: { id: TabType; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "chat", label: "Fleet Chat", icon: <MessageSquare className="w-3.5 h-3.5" /> },
    {
      id: "approvals",
      label: "Approvals",
      icon: <ShieldAlert className="w-3.5 h-3.5" />,
      badge: pendingApprovalsCount,
    },
    { id: "catalog", label: "Specialists", icon: <Users className="w-3.5 h-3.5" /> },
    { id: "traces", label: "Traces", icon: <Activity className="w-3.5 h-3.5" /> },
    { id: "mcp", label: "MCP", icon: <Cpu className="w-3.5 h-3.5" /> },
    { id: "a2a", label: "A2A", icon: <Network className="w-3.5 h-3.5" /> },
    { id: "wiki", label: "Wiki", icon: <BookOpen className="w-3.5 h-3.5" /> },
    { id: "terminal", label: "Terminal", icon: <Terminal className="w-3.5 h-3.5" /> },
    { id: "doctor", label: "Doctor", icon: <HeartPulse className="w-3.5 h-3.5" /> },
    { id: "settings", label: "Settings", icon: <Settings className="w-3.5 h-3.5" /> },
  ];

  const budgetPct = Math.round((budget.spent / budget.cap) * 100);

  return (
    <header className="h-14 bg-[#161922] border-b border-[#262B3B] px-4 flex items-center justify-between select-none">
      {/* Brand & Fleet status */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-indigo-700 flex items-center justify-center shadow-lg shadow-purple-900/30">
          <Zap className="w-5 h-5 text-white fill-current" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-sm tracking-tight text-white font-mono">TRENT FLEET</span>
            <span className="text-[10px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30">
              Desktop
            </span>
          </div>
          <div className="text-[11px] text-gray-400 flex items-center gap-1.5 font-mono">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${doctorHealthy ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
            {activeProvider}:{activeModel}
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <nav className="flex items-center gap-1 bg-[#0F1117] p-1 rounded-lg border border-[#262B3B] overflow-x-auto max-w-2xl">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all shrink-0 ${
                isActive
                  ? "bg-[#8B5CF6] text-white shadow-sm"
                  : "text-gray-400 hover:text-gray-200 hover:bg-[#1A1D27]"
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {tab.badge !== undefined && tab.badge > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-red-500 text-white animate-bounce">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Budget & System Pill */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 bg-[#1A1D27] px-3 py-1.5 rounded-lg border border-[#262B3B] text-xs font-mono">
          <span className="text-gray-400">Budget:</span>
          <span className="font-semibold text-emerald-400">
            ${budget.spent.toFixed(2)}
          </span>
          <span className="text-gray-500">/</span>
          <span className="text-gray-400">${budget.cap.toFixed(2)}</span>
          <span className="text-[10px] text-gray-500">({budgetPct}%)</span>
        </div>
      </div>
    </header>
  );
};
