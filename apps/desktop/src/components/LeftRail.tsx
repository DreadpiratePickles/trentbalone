import React from "react";
import {
  Briefcase,
  Code2,
  TrendingUp,
  FileText,
  Headphones,
  BarChart3,
  DollarSign,
  Globe,
  AlertTriangle,
  PlusCircle,
  Layers,
} from "lucide-react";
import type { AgentSeat } from "../types.js";

interface LeftRailProps {
  agents: AgentSeat[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
  onOpenCatalog: () => void;
  installedCount: number;
  totalCount: number;
}

export const LeftRail: React.FC<LeftRailProps> = ({
  agents,
  selectedAgentId,
  onSelectAgent,
  onOpenCatalog,
  installedCount,
  totalCount,
}) => {
  const getIcon = (role: string) => {
    switch (role.toLowerCase()) {
      case "ceo":
        return <Briefcase className="w-4 h-4 text-purple-400" />;
      case "engineer":
      case "eng-ai-engineer":
        return <Code2 className="w-4 h-4 text-cyan-400" />;
      case "growth":
        return <TrendingUp className="w-4 h-4 text-emerald-400" />;
      case "content":
        return <FileText className="w-4 h-4 text-amber-400" />;
      case "support":
      case "sup-support-responder":
        return <Headphones className="w-4 h-4 text-blue-400" />;
      case "analyst":
        return <BarChart3 className="w-4 h-4 text-pink-400" />;
      case "finance":
        return <DollarSign className="w-4 h-4 text-red-400" />;
      case "browser":
        return <Globe className="w-4 h-4 text-indigo-400" />;
      case "escalation":
        return <AlertTriangle className="w-4 h-4 text-orange-400" />;
      default:
        return <Layers className="w-4 h-4 text-gray-400" />;
    }
  };

  return (
    <aside className="w-64 bg-[#161922] border-r border-[#262B3B] flex flex-col h-[calc(100vh-3.5rem)] select-none">
      {/* Operating Seats Header */}
      <div className="p-3 border-b border-[#262B3B] flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
          Operating Seats
        </span>
        <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#1A1D27] text-purple-400 border border-[#262B3B]">
          {installedCount}/{totalCount} Active
        </span>
      </div>

      {/* Agents List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {agents.map((agent) => {
          const isSelected = selectedAgentId === agent.id;
          return (
            <button
              key={agent.id}
              onClick={() => onSelectAgent(agent.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all ${
                isSelected
                  ? "bg-[#8B5CF6]/15 border border-[#8B5CF6]/40 text-white"
                  : "hover:bg-[#1A1D27] border border-transparent text-gray-300"
              }`}
            >
              <div className="p-1.5 rounded-md bg-[#0F1117] border border-[#262B3B]">
                {getIcon(agent.id)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-xs truncate capitalize">{agent.name}</span>
                  {agent.active && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  )}
                </div>
                <div className="text-[10px] text-gray-400 truncate">{agent.role}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Specialist Catalog Fast Launcher */}
      <div className="p-3 border-t border-[#262B3B] bg-[#0F1117]/50">
        <button
          onClick={onOpenCatalog}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-[#1A1D27] hover:bg-[#232736] border border-[#262B3B] text-xs font-semibold text-purple-400 hover:text-purple-300 transition-colors"
        >
          <PlusCircle className="w-4 h-4" />
          <span>Deploy Specialists (164)</span>
        </button>
      </div>
    </aside>
  );
};
