import React, { useState, useEffect, useRef } from "react";
import { Terminal as TermIcon, Play, Trash2, ArrowRight } from "lucide-react";
import { terminalSession, type TerminalOutputLine } from "../terminal.js";

export const EmbeddedTerminal: React.FC = () => {
  const [lines, setLines] = useState<TerminalOutputLine[]>(terminalSession.getHistory());
  const [cmd, setCmd] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = terminalSession.subscribe((updated) => {
      setLines(updated);
    });
    return unsub;
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const handleExecute = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cmd.trim()) return;
    terminalSession.executeCommand(cmd.trim());
    setCmd("");
  };

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] bg-[#0A0C10] font-mono text-xs select-none">
      {/* Terminal Title Bar */}
      <div className="h-10 bg-[#161922] border-b border-[#262B3B] px-4 flex items-center justify-between">
        <div className="flex items-center gap-2 text-gray-400">
          <TermIcon className="w-4 h-4 text-purple-400" />
          <span className="font-semibold text-white">Trent Interactive PTY Terminal</span>
          <span className="text-[10px] bg-[#1A1D27] px-2 py-0.5 rounded border border-[#262B3B] text-emerald-400">
            LOCAL PTY SANDBOX
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => terminalSession.executeCommand("trent doctor")}
            className="px-2 py-1 rounded bg-[#1A1D27] hover:bg-[#232736] text-[11px] text-cyan-400 border border-[#262B3B]"
          >
            trent doctor
          </button>
          <button
            onClick={() => terminalSession.executeCommand("trent fleet status")}
            className="px-2 py-1 rounded bg-[#1A1D27] hover:bg-[#232736] text-[11px] text-purple-400 border border-[#262B3B]"
          >
            fleet status
          </button>
          <button
            onClick={() => terminalSession.executeCommand("clear")}
            className="p-1 rounded bg-[#1A1D27] hover:bg-[#232736] text-gray-400 hover:text-white border border-[#262B3B]"
            title="Clear terminal"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Output */}
      <div className="flex-1 overflow-y-auto p-4 space-y-1.5 leading-relaxed">
        {lines.map((line) => {
          let textClass = "text-gray-300";
          if (line.type === "stdin") textClass = "text-purple-400 font-bold";
          else if (line.type === "stderr") textClass = "text-red-400";
          else if (line.type === "system") textClass = "text-gray-500 italic";

          return (
            <div key={line.id} className="flex items-start gap-2">
              <span className="text-[10px] text-gray-600 select-none">{line.timestamp}</span>
              <span className={textClass}>{line.text}</span>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* Terminal Input */}
      <form
        onSubmit={handleExecute}
        className="h-11 bg-[#161922] border-t border-[#262B3B] px-4 flex items-center gap-2"
      >
        <span className="text-purple-400 font-bold select-none">trent&gt;</span>
        <input
          type="text"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="Enter CLI command (e.g. trent doctor, trent setup, trent fleet)..."
          className="flex-1 bg-transparent text-white focus:outline-none placeholder-gray-600 text-xs"
        />
        <button
          type="submit"
          className="p-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white transition-colors"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </form>
    </div>
  );
};
