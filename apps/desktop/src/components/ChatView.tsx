import React, { useState, useRef, useEffect } from "react";
import { Send, Mic, Sparkles, Terminal, FileCode, Clock, DollarSign, Cpu } from "lucide-react";
import type { ChatMessage, AgentSeat } from "../types.js";

interface ChatViewProps {
  agent: AgentSeat;
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  onRequestApproval?: (action: string) => void;
}

export const ChatView: React.FC<ChatViewProps> = ({
  agent,
  messages,
  onSendMessage,
}) => {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendMessage(input.trim());
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] bg-[#0F1117]">
      {/* Header with cofounder profile */}
      <div className="h-12 border-b border-[#262B3B] px-6 flex items-center justify-between bg-[#161922]/50">
        <div className="flex items-center gap-3">
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: agent.color || "#8B5CF6" }}
          />
          <h2 className="text-sm font-bold text-white capitalize">{agent.name}</h2>
          <span className="text-xs text-gray-400 font-mono">[{agent.role}]</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-400 bg-[#1A1D27] px-2 py-0.5 rounded border border-[#262B3B] font-mono">
            Autonomous Co-Founder Mode
          </span>
        </div>
      </div>

      {/* Message History */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 text-gray-400">
            <Sparkles className="w-10 h-10 text-purple-400 mb-3 animate-pulse" />
            <h3 className="text-base font-semibold text-white mb-1">
              Ready to collaborate with your {agent.name}
            </h3>
            <p className="text-xs text-gray-400 max-w-sm mb-4">
              Ask questions, delegate architectural reviews, plan marketing blitzes, or invoke specialist subagents.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => onSendMessage("Review current sprint roadmap and highlight top engineering risks")}
                className="text-xs px-3 py-1.5 rounded-lg bg-[#1A1D27] hover:bg-[#232736] border border-[#262B3B] text-purple-400"
              >
                Review Sprint Risks
              </button>
              <button
                onClick={() => onSendMessage("Run full diagnostic health check on active fleet")}
                className="text-xs px-3 py-1.5 rounded-lg bg-[#1A1D27] hover:bg-[#232736] border border-[#262B3B] text-cyan-400"
              >
                Health Diagnostic
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === "user";
            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-2xl rounded-xl p-4 text-xs leading-relaxed shadow-md ${
                    isUser
                      ? "bg-purple-600 text-white rounded-br-none"
                      : "bg-[#1A1D27] border border-[#262B3B] text-gray-100 rounded-bl-none"
                  }`}
                >
                  {!isUser && (
                    <div className="flex items-center gap-2 mb-2 pb-2 border-b border-[#262B3B]/60 text-[11px] font-mono">
                      <span className="font-bold text-purple-400 uppercase">
                        [{msg.agent || agent.name}]
                      </span>
                      {msg.metadata?.model && (
                        <span className="flex items-center gap-1 text-gray-400">
                          <Cpu className="w-3 h-3" /> {msg.metadata.model}
                        </span>
                      )}
                    </div>
                  )}

                  {msg.metadata?.thought && (
                    <div className="mb-2 p-2 rounded bg-[#0F1117] border border-[#262B3B] text-gray-400 font-mono text-[11px] italic">
                      💭 {msg.metadata.thought}
                    </div>
                  )}

                  <div className="whitespace-pre-wrap font-sans">{msg.content}</div>

                  {msg.metadata?.file && (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-gray-400 font-mono bg-[#0F1117] p-1.5 rounded border border-[#262B3B]">
                      <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                      <span>{msg.metadata.file}</span>
                      {msg.metadata.lines && <span>({msg.metadata.lines} lines)</span>}
                    </div>
                  )}

                  {!isUser && msg.metadata && (
                    <div className="mt-2 pt-2 border-t border-[#262B3B]/40 flex items-center gap-3 text-[10px] text-gray-500 font-mono">
                      {msg.metadata.durationMs && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" /> {(msg.metadata.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                      {msg.metadata.cost && (
                        <span className="flex items-center gap-1">
                          <DollarSign className="w-3 h-3" /> ${msg.metadata.cost.toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Form */}
      <div className="p-4 bg-[#161922] border-t border-[#262B3B]">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <div className="flex-1 bg-[#0F1117] border border-[#262B3B] rounded-xl p-2 focus-within:border-purple-500 transition-colors">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${agent.name} or type / for slash commands...`}
              rows={2}
              className="w-full bg-transparent resize-none text-xs text-white focus:outline-none placeholder-gray-500 font-sans"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              className="p-2.5 rounded-lg bg-[#1A1D27] hover:bg-[#232736] border border-[#262B3B] text-gray-400 hover:text-purple-400 transition-colors"
              title="Push-to-Talk (Whisper Voice)"
            >
              <Mic className="w-4 h-4" />
            </button>
            <button
              type="submit"
              disabled={!input.trim()}
              className="p-2.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:hover:bg-purple-600 text-white font-semibold transition-colors shadow-sm"
              title="Send Message"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
