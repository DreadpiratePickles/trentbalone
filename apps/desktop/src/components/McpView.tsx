import React, { useState } from "react";
import { Cpu, ShieldAlert, CheckCircle, Plus, Trash2, Search } from "lucide-react";
import type { McpConnector } from "../types.js";

const DEFAULT_CONNECTORS: McpConnector[] = [
  {
    id: "github",
    name: "GitHub Developer Connector",
    description: "Inspect repositories, read issues, create pull requests, review commits.",
    transport: "http",
    trustScore: 98,
    riskTier: "medium",
    installed: true,
  },
  {
    id: "postgres",
    name: "PostgreSQL Database Connector",
    description: "Read-only SQL schema introspection, query execution, migration verification.",
    transport: "stdio",
    trustScore: 95,
    riskTier: "high",
    installed: true,
  },
  {
    id: "slack",
    name: "Slack Team Communications",
    description: "Post notifications, monitor channels, reply to threads with approval gates.",
    transport: "sse",
    trustScore: 92,
    riskTier: "low",
    installed: false,
  },
  {
    id: "stripe",
    name: "Stripe Billing & Subscriptions",
    description: "Monitor customer MRR, verify active seat entitlements, inspect disputes.",
    transport: "http",
    trustScore: 99,
    riskTier: "high",
    installed: false,
  },
  {
    id: "playwright",
    name: "Headless Browser Automation",
    description: "Execute web browser automation, take screenshots, scrape dynamic DOMs.",
    transport: "stdio",
    trustScore: 91,
    riskTier: "medium",
    installed: true,
  },
];

export const McpView: React.FC = () => {
  const [connectors, setConnectors] = useState<McpConnector[]>(DEFAULT_CONNECTORS);
  const [searchTerm, setSearchTerm] = useState("");

  const handleToggleInstall = (id: string) => {
    setConnectors((prev) =>
      prev.map((c) => (c.id === id ? { ...c, installed: !c.installed } : c))
    );
  };

  const filtered = connectors.filter(
    (c) =>
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col bg-[#0F1117] overflow-hidden">
      {/* Top Header */}
      <div className="h-14 border-b border-[#262B3B] px-6 flex items-center justify-between bg-[#161922]">
        <div className="flex items-center gap-3">
          <Cpu className="w-5 h-5 text-[#06B6D4]" />
          <div>
            <h2 className="text-sm font-bold text-white tracking-wide">
              MODEL CONTEXT PROTOCOL (MCP) CONNECTORS
            </h2>
            <p className="text-[11px] text-gray-400">
              Stateless HTTP/SSE standard with cryptographic trust scores & sandboxed execution
            </p>
          </div>
        </div>

        <div className="text-xs text-gray-400 font-mono">
          <span className="text-[#06B6D4] font-bold">
            {connectors.filter((c) => c.installed).length}
          </span>{" "}
          of {connectors.length} active
        </div>
      </div>

      {/* Search Bar */}
      <div className="p-4 border-b border-[#262B3B] bg-[#161922]">
        <div className="relative max-w-md">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Search MCP connectors..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-[#0F1117] border border-[#262B3B] rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-[#06B6D4]"
          />
        </div>
      </div>

      {/* Connectors Grid */}
      <div className="flex-1 p-6 overflow-y-auto grid grid-cols-2 gap-4">
        {filtered.map((conn) => (
          <div
            key={conn.id}
            className="p-5 bg-[#161922] border border-[#262B3B] rounded-xl flex flex-col justify-between hover:border-gray-600 transition"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-white">{conn.name}</h3>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">
                    {conn.transport.toUpperCase()}
                  </span>
                </div>
                <span
                  className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
                    conn.trustScore >= 95
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                      : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
                  }`}
                >
                  Trust: {conn.trustScore}%
                </span>
              </div>

              <p className="text-xs text-gray-400 mb-4">{conn.description}</p>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-[#262B3B]">
              <span
                className={`text-[11px] font-mono capitalize ${
                  conn.riskTier === "high"
                    ? "text-red-400"
                    : conn.riskTier === "medium"
                    ? "text-amber-400"
                    : "text-emerald-400"
                }`}
              >
                Risk: {conn.riskTier}
              </span>

              <button
                onClick={() => handleToggleInstall(conn.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  conn.installed
                    ? "bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30"
                    : "bg-[#06B6D4] hover:bg-[#0891B2] text-white"
                }`}
              >
                {conn.installed ? (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Disconnect</span>
                  </>
                ) : (
                  <>
                    <Plus className="w-3.5 h-3.5" />
                    <span>Connect MCP</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
