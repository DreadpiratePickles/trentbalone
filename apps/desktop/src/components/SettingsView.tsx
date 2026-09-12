import React, { useState } from "react";
import { Key, Shield, MessageCircle, Mic, Terminal, Bot, Save } from "lucide-react";

interface SettingsViewProps {
  currentProvider: string;
  currentModel: string;
  onSaveConfig: (provider: string, model: string, apiKey: string) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  currentProvider,
  currentModel,
  onSaveConfig,
}) => {
  const [provider, setProvider] = useState(currentProvider);
  const [model, setModel] = useState(currentModel);
  const [apiKey, setApiKey] = useState("");
  const [personality, setPersonality] = useState("founder");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [saved, setSaved] = useState(false);

  const providers = [
    { id: "openai", name: "OpenAI", defaultModel: "gpt-5.6-terra" },
    { id: "anthropic", name: "Anthropic", defaultModel: "claude-3-7-sonnet" },
    { id: "google", name: "Google Gemini", defaultModel: "gemini-2.5-pro" },
    { id: "groq", name: "Groq LPU", defaultModel: "llama-3.3-70b" },
    { id: "ollama", name: "Ollama Local", defaultModel: "llama3:latest" },
    { id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-reasoner" },
  ];

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveConfig(provider, model, apiKey);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="flex-1 p-6 bg-[#0F1117] h-[calc(100vh-3.5rem)] overflow-y-auto select-none">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="pb-4 border-b border-[#262B3B]">
          <h2 className="text-base font-bold text-white">System Settings & Gateway Matrix</h2>
          <p className="text-xs text-gray-400">
            Configure model routing, credentials, ACP bridge, and messaging gateways.
          </p>
        </div>

        <form onSubmit={handleSave} className="space-y-6">
          {/* Provider & Model Selection */}
          <div className="bg-[#161922] border border-[#262B3B] rounded-xl p-5 space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-purple-400 font-mono flex items-center gap-2">
              <Bot className="w-4 h-4" />
              Primary LLM Provider
            </h3>

            <div className="grid grid-cols-3 gap-3">
              {providers.map((p) => {
                const isSelected = provider === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setProvider(p.id);
                      setModel(p.defaultModel);
                    }}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      isSelected
                        ? "bg-purple-500/20 border-purple-500 text-white"
                        : "bg-[#0F1117] border-[#262B3B] text-gray-400 hover:text-white"
                    }`}
                  >
                    <div className="text-xs font-bold">{p.name}</div>
                    <div className="text-[10px] text-gray-500 truncate mt-0.5">{p.defaultModel}</div>
                  </button>
                );
              })}
            </div>

            <div className="space-y-3 pt-2">
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">Model Name</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-[#0F1117] border border-[#262B3B] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1 flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-gray-400" />
                  API Key ({provider.toUpperCase()})
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full bg-[#0F1117] border border-[#262B3B] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500 font-mono"
                />
              </div>
            </div>
          </div>

          {/* Personality & Tone */}
          <div className="bg-[#161922] border border-[#262B3B] rounded-xl p-5 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400 font-mono">
              Active Personality Tone
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {["founder", "pirate", "robot", "concise", "executive", "academic"].map((pers) => (
                <button
                  key={pers}
                  type="button"
                  onClick={() => setPersonality(pers)}
                  className={`p-2.5 rounded-lg border text-xs capitalize transition-colors ${
                    personality === pers
                      ? "bg-cyan-500/20 border-cyan-500 text-white font-bold"
                      : "bg-[#0F1117] border-[#262B3B] text-gray-400 hover:text-white"
                  }`}
                >
                  {pers}
                </button>
              ))}
            </div>
          </div>

          {/* Subsystems Toggles */}
          <div className="bg-[#161922] border border-[#262B3B] rounded-xl p-5 space-y-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400 font-mono">
              Subsystems & Bridge Controls
            </h3>

            <div className="flex items-center justify-between p-3 rounded-lg bg-[#0F1117] border border-[#262B3B]">
              <div className="flex items-center gap-2.5">
                <Mic className="w-4 h-4 text-emerald-400" />
                <div>
                  <div className="text-xs font-semibold text-white">Local Whisper Voice Loop</div>
                  <div className="text-[11px] text-gray-400">Push-to-talk voice cofounder transcription</div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={voiceEnabled}
                onChange={(e) => setVoiceEnabled(e.target.checked)}
                className="w-4 h-4 accent-purple-600 rounded"
              />
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg bg-[#0F1117] border border-[#262B3B]">
              <div className="flex items-center gap-2.5">
                <Terminal className="w-4 h-4 text-purple-400" />
                <div>
                  <div className="text-xs font-semibold text-white">ACP Editor Server (JSON-RPC)</div>
                  <div className="text-[11px] text-gray-400">Port 7890 active for Cursor, VS Code, and Zed</div>
                </div>
              </div>
              <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                LISTENING
              </span>
            </div>
          </div>

          {/* Save Action */}
          <div className="flex items-center justify-end gap-3 pt-2">
            {saved && (
              <span className="text-xs text-emerald-400 font-semibold animate-fade-in">
                ✓ Settings updated successfully!
              </span>
            )}
            <button
              type="submit"
              className="flex items-center gap-2 px-5 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs transition-colors shadow-sm"
            >
              <Save className="w-4 h-4" />
              <span>Save Configuration</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
