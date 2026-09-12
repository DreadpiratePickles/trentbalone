import React, { useState } from "react";
import { Activity, ShieldCheck, Download, Search, Filter } from "lucide-react";
import type { TraceSpan } from "../types.js";

const SAMPLE_TRACES: TraceSpan[] = [
  {
    id: "span-001",
    traceId: "tr-7f9a2b",
    name: "gen_ai.workflow.orchestrate",
    agent: "Trent CEO",
    model: "claude-3-7-sonnet",
    durationMs: 840,
    cost: 0.032,
    tokensPrompt: 1420,
    tokensCompletion: 380,
    timestamp: "10:42:15 AM",
    status: "ok",
    hasRedactions: true,
  },
  {
    id: "span-002",
    traceId: "tr-7f9a2b",
    name: "gen_ai.tool.call:file_ops",
    agent: "Lead Engineer",
    model: "gpt-5.6-terra",
    durationMs: 410,
    cost: 0.015,
    tokensPrompt: 890,
    tokensCompletion: 120,
    timestamp: "10:42:16 AM",
    status: "ok",
    hasRedactions: true,
  },
  {
    id: "span-003",
    traceId: "tr-7f9a2b",
    name: "gen_ai.agent.review:critic",
    agent: "Lead Engineer",
    model: "claude-3-7-sonnet",
    durationMs: 320,
    cost: 0.012,
    tokensPrompt: 640,
    tokensCompletion: 95,
    timestamp: "10:42:17 AM",
    status: "ok",
    hasRedactions: false,
  },
  {
    id: "span-004",
    traceId: "tr-3d1e9c",
    name: "gen_ai.task.triage",
    agent: "Support Lead",
    model: "gemini-2.5-pro",
    durationMs: 190,
    cost: 0.005,
    tokensPrompt: 410,
    tokensCompletion: 60,
    timestamp: "10:38:02 AM",
    status: "ok",
    hasRedactions: false,
  },
];

export const TracesView: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedSpan, setSelectedSpan] = useState<TraceSpan | null>(SAMPLE_TRACES[0]);

  const filtered = SAMPLE_TRACES.filter(
    (s) =>
      s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.agent.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.traceId.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col bg-[#0F1117] overflow-hidden">
      {/* Header */}
      <div className="h-14 border-b border-[#262B3B] px-6 flex items-center justify-between bg-[#161922]">
        <div className="flex items-center gap-3">
          <Activity className="w-5 h-5 text-[#8B5CF6]" />
          <div>
            <h2 className="text-sm font-bold text-white tracking-wide">
              OPENTELEMETRY TRACES & OBSERVABILITY
            </h2>
            <p className="text-[11px] text-gray-400">
              OpenTelemetry <code className="text-[#06B6D4]">gen_ai.*</code> standard · PII & API Key Redactor Active
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/30 rounded-md text-emerald-400 text-xs font-mono">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Redaction: ON</span>
          </div>
          <button
            onClick={() => alert("Exported telemetry batch to OTel Collector / Langfuse.")}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-md text-xs font-semibold transition"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Traces</span>
          </button>
        </div>
      </div>

      {/* Main Body: 2 columns */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left List */}
        <div className="w-1/2 border-r border-[#262B3B] flex flex-col">
          <div className="p-3 border-b border-[#262B3B] bg-[#161922]">
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Filter by span name, agent, or trace ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-[#0F1117] border border-[#262B3B] rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-[#8B5CF6]"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {filtered.map((span) => {
              const isSelected = selectedSpan?.id === span.id;
              return (
                <div
                  key={span.id}
                  onClick={() => setSelectedSpan(span)}
                  className={`p-3 rounded-lg border cursor-pointer transition ${
                    isSelected
                      ? "bg-[#1F2432] border-[#8B5CF6]"
                      : "bg-[#161922] border-[#262B3B] hover:border-gray-600"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-white">
                      {span.name}
                    </span>
                    <span className="text-[11px] text-gray-400">{span.timestamp}</span>
                  </div>

                  <div className="flex items-center gap-2 mt-1.5 text-xs">
                    <span className="text-[#8B5CF6] font-semibold">{span.agent}</span>
                    <span className="text-gray-500">·</span>
                    <span className="text-[#06B6D4] font-mono">{span.model}</span>
                  </div>

                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#262B3B]/60 text-[11px] font-mono text-gray-400">
                    <span>⏱ {span.durationMs}ms</span>
                    <span>💰 ${span.cost.toFixed(3)}</span>
                    <span>🔢 {span.tokensPrompt + span.tokensCompletion} tokens</span>
                    {span.hasRedactions && (
                      <span className="text-emerald-400">🔒 Redacted</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Detail Pane */}
        <div className="w-1/2 p-6 overflow-y-auto bg-[#0F1117]">
          {selectedSpan ? (
            <div className="space-y-4">
              <div className="p-4 bg-[#161922] rounded-lg border border-[#262B3B]">
                <h3 className="text-sm font-bold text-[#8B5CF6] mb-1">
                  SPAN ATTRIBUTES
                </h3>
                <div className="font-mono text-xs space-y-1.5 text-gray-300">
                  <div>
                    <span className="text-gray-500">trace.id:</span> {selectedSpan.traceId}
                  </div>
                  <div>
                    <span className="text-gray-500">span.id:</span> {selectedSpan.id}
                  </div>
                  <div>
                    <span className="text-gray-500">gen_ai.system:</span> {selectedSpan.agent}
                  </div>
                  <div>
                    <span className="text-gray-500">gen_ai.request.model:</span>{" "}
                    {selectedSpan.model}
                  </div>
                  <div>
                    <span className="text-gray-500">gen_ai.usage.input_tokens:</span>{" "}
                    {selectedSpan.tokensPrompt}
                  </div>
                  <div>
                    <span className="text-gray-500">gen_ai.usage.output_tokens:</span>{" "}
                    {selectedSpan.tokensCompletion}
                  </div>
                  <div>
                    <span className="text-gray-500">gen_ai.cost.usd:</span> $
                    {selectedSpan.cost.toFixed(4)}
                  </div>
                </div>
              </div>

              <div className="p-4 bg-[#161922] rounded-lg border border-[#262B3B]">
                <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>PII & Credential Scrubbing</span>
                </h3>
                <p className="text-xs text-gray-400 leading-relaxed">
                  All authorization headers, Bearer tokens, OpenAI/Anthropic keys (`sk-...`),
                  and sensitive customer credentials have been automatically sanitized to{" "}
                  <code className="text-emerald-400 bg-emerald-950/40 px-1 py-0.5 rounded font-mono">
                    [REDACTED_API_KEY]
                  </code>{" "}
                  before trace persistence.
                </p>
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-gray-500 text-sm">
              Select a trace span to inspect details.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
