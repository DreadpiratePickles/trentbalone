import React, { useState, useMemo } from "react";
import { Search, Plus, Check, Zap, Layers, Sparkles, Filter } from "lucide-react";
import type { AgentSeat } from "../types.js";

interface CatalogViewProps {
  agents: AgentSeat[];
  onToggleInstall: (agentId: string) => void;
  onToggleDeploy: (agentId: string) => void;
  onInstallPack: (packName: string) => void;
}

export const CatalogView: React.FC<CatalogViewProps> = ({
  agents,
  onToggleInstall,
  onToggleDeploy,
  onInstallPack,
}) => {
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  const categories = useMemo(() => {
    const set = new Set(agents.map((a) => a.category));
    return ["all", ...Array.from(set)];
  }, [agents]);

  const filtered = useMemo(() => {
    return agents.filter((a) => {
      const matchCat = selectedCategory === "all" || a.category === selectedCategory;
      const matchQuery =
        search === "" ||
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.role.toLowerCase().includes(search.toLowerCase()) ||
        a.description.toLowerCase().includes(search.toLowerCase());
      return matchCat && matchQuery;
    });
  }, [agents, search, selectedCategory]);

  return (
    <div className="flex-1 p-6 bg-[#0F1117] h-[calc(100vh-3.5rem)] overflow-y-auto select-none">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Catalog Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#262B3B]">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-400" />
              <h2 className="text-base font-bold text-white">164-Specialist Agent Fleet</h2>
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              Browse, install, and deploy high-leverage AI cofounder specialists to your workspace.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onInstallPack("starter")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1A1D27] hover:bg-[#232736] border border-[#262B3B] text-xs font-semibold text-purple-400 transition-colors"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Starter Trio</span>
            </button>
            <button
              onClick={() => onInstallPack("all")}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs font-semibold text-white transition-colors shadow-sm"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Deploy Full Fleet (164)</span>
            </button>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex flex-col sm:flex-row items-center gap-3">
          <div className="relative flex-1 w-full">
            <Search className="w-4 h-4 text-gray-500 absolute left-3 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search specialists by skill, role, or capability..."
              className="w-full bg-[#161922] border border-[#262B3B] rounded-lg pl-9 pr-4 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
            />
          </div>

          {/* Category Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
            {categories.slice(0, 6).map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`text-[11px] font-medium px-3 py-1.5 rounded-lg border capitalize whitespace-nowrap transition-colors ${
                  selectedCategory === cat
                    ? "bg-purple-500/20 border-purple-500/50 text-purple-300"
                    : "bg-[#161922] border-[#262B3B] text-gray-400 hover:text-gray-200"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Specialists Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((agent) => (
            <div
              key={agent.id}
              className="bg-[#161922] border border-[#262B3B] rounded-xl p-4 flex flex-col justify-between hover:border-purple-500/40 transition-colors shadow-sm"
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] uppercase font-mono font-bold tracking-wider px-2 py-0.5 rounded bg-[#1A1D27] text-purple-400 border border-[#262B3B]">
                    {agent.category}
                  </span>
                  {agent.active && (
                    <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Active Duty
                    </span>
                  )}
                </div>

                <h3 className="text-sm font-bold text-white mb-1 capitalize">{agent.name}</h3>
                <p className="text-xs text-gray-400 line-clamp-2 leading-relaxed mb-3">
                  {agent.description}
                </p>
              </div>

              <div className="pt-3 border-t border-[#262B3B]/60 flex items-center justify-between">
                <span className="text-[10px] font-mono text-gray-500">ID: {agent.id}</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onToggleInstall(agent.id)}
                    className={`text-xs px-2.5 py-1 rounded-md border font-medium transition-colors ${
                      agent.installed
                        ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                        : "bg-[#1A1D27] border-[#262B3B] text-gray-300 hover:text-white"
                    }`}
                  >
                    {agent.installed ? "Installed" : "Install"}
                  </button>
                  {agent.installed && (
                    <button
                      onClick={() => onToggleDeploy(agent.id)}
                      className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
                        agent.active
                          ? "bg-purple-600/30 border border-purple-500 text-purple-300"
                          : "bg-purple-600 hover:bg-purple-500 text-white"
                      }`}
                    >
                      {agent.active ? "Deployed" : "Deploy"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
