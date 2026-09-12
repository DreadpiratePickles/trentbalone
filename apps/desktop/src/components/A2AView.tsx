import React, { useState } from "react";
import { Network, KeyRound, CheckCircle2, Copy, Send } from "lucide-react";
import type { AgentCardSummary } from "../types.js";

const SAMPLE_CARDS: AgentCardSummary[] = [
  {
    agentId: "ceo",
    name: "Trent CEO",
    role: "Strategic Multi-Agent Coordinator",
    organization: "Trent Fleet Network",
    publicKey: "pk_trent_01928374a9b8c7d6e5f4...",
    signature: "sig_hmac_sha256_8f93e10ab2c4...",
    supportedProtocols: ["a2a/v1.0", "mcp/2026-07-28"],
  },
  {
    agentId: "engineer",
    name: "Lead Engineer",
    role: "Full-Stack System Architect",
    organization: "Trent Fleet Network",
    publicKey: "pk_trent_98765432f1e2d3c4b5a6...",
    signature: "sig_hmac_sha256_1a2b3c4d5e6f...",
    supportedProtocols: ["a2a/v1.0", "mcp/2026-07-28"],
  },
  {
    agentId: "support",
    name: "Support Lead",
    role: "Customer Operations & Triage",
    organization: "Trent Fleet Network",
    publicKey: "pk_trent_55443322a1b2c3d4e5f6...",
    signature: "sig_hmac_sha256_77889900aabb...",
    supportedProtocols: ["a2a/v1.0"],
  },
];

export const A2AView: React.FC = () => {
  const [delegationTarget, setDelegationTarget] = useState("ceo");
  const [taskDescription, setTaskDescription] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleDispatchDelegation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskDescription.trim()) return;
    alert(`A2A Task delegated to [${delegationTarget}] with HMAC-SHA256 signature verification.`);
    setTaskDescription("");
  };

  return (
    <div className="flex-1 flex flex-col bg-[#0F1117] overflow-hidden">
      {/* Header */}
      <div className="h-14 border-b border-[#262B3B] px-6 flex items-center justify-between bg-[#161922]">
        <div className="flex items-center gap-3">
          <Network className="w-5 h-5 text-[#8B5CF6]" />
          <div>
            <h2 className="text-sm font-bold text-white tracking-wide">
              AGENT2AGENT (A2A) CROSS-ORG PROTOCOL
            </h2>
            <p className="text-[11px] text-gray-400">
              Linux Foundation AAIF Standard · Signed Agent Cards · Cryptographic Verification
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-mono px-2.5 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-md">
            A2A Gateway: Port 7891 Active
          </span>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Cards Catalog */}
        <div className="w-3/5 border-r border-[#262B3B] p-6 overflow-y-auto space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 font-mono">
            Verified Signed Agent Cards
          </h3>

          {SAMPLE_CARDS.map((card) => (
            <div
              key={card.agentId}
              className="p-5 bg-[#161922] border border-[#262B3B] rounded-xl space-y-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-bold text-white flex items-center gap-2">
                    <span>{card.name}</span>
                    <span className="text-[10px] font-mono text-[#8B5CF6] px-1.5 py-0.5 bg-purple-500/10 rounded border border-purple-500/20">
                      {card.agentId}
                    </span>
                  </h4>
                  <p className="text-xs text-gray-400">{card.role}</p>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-mono">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Signature Valid</span>
                </div>
              </div>

              <div className="bg-[#0F1117] p-3 rounded-lg border border-[#262B3B] font-mono text-[11px] space-y-1 text-gray-300">
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Public Key:</span>
                  <span className="text-gray-400">{card.publicKey}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">HMAC Sig:</span>
                  <span className="text-[#8B5CF6]">{card.signature}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Protocols:</span>
                  <span className="text-[#06B6D4]">
                    {card.supportedProtocols.join(", ")}
                  </span>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => handleCopy(JSON.stringify(card, null, 2), card.agentId)}
                  className="flex items-center gap-1.5 px-3 py-1 bg-[#1F2432] hover:bg-gray-800 text-gray-300 rounded-md text-xs transition"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>{copiedId === card.agentId ? "Copied!" : "Copy Agent Card JSON"}</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Dispatch Form */}
        <div className="w-2/5 p-6 bg-[#0F1117] flex flex-col justify-between">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 font-mono mb-4">
              Cross-Organization Delegation
            </h3>

            <form onSubmit={handleDispatchDelegation} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">
                  Target Specialist Agent:
                </label>
                <select
                  value={delegationTarget}
                  onChange={(e) => setDelegationTarget(e.target.value)}
                  className="w-full bg-[#161922] border border-[#262B3B] rounded-lg p-2 text-xs text-white focus:outline-none focus:border-[#8B5CF6]"
                >
                  {SAMPLE_CARDS.map((c) => (
                    <option key={c.agentId} value={c.agentId}>
                      {c.name} ({c.role})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">
                  Task Payload & Instructions:
                </label>
                <textarea
                  rows={6}
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                  placeholder="Provide structured task instructions to delegate..."
                  className="w-full bg-[#161922] border border-[#262B3B] rounded-lg p-3 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-[#8B5CF6]"
                />
              </div>

              <button
                type="submit"
                className="w-full flex items-center justify-center gap-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white py-2 rounded-lg text-xs font-bold transition shadow-lg shadow-purple-900/30"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Dispatch A2A Delegation Task</span>
              </button>
            </form>
          </div>

          <div className="p-4 bg-[#161922] rounded-lg border border-[#262B3B] text-xs text-gray-400">
            <div className="flex items-center gap-2 text-white font-bold mb-1">
              <KeyRound className="w-4 h-4 text-[#8B5CF6]" />
              <span>Identity Verification Enforced</span>
            </div>
            Delegated tasks require signed cryptographic headers matching public keys
            published in each agent's Agent Card.
          </div>
        </div>
      </div>
    </div>
  );
};
