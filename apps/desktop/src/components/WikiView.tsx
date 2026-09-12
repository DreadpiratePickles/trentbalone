import React, { useState } from "react";
import { BookOpen, FileText, Upload, Plus, Folder, Sparkles } from "lucide-react";

interface WikiDoc {
  id: string;
  title: string;
  category: "Strategic" | "Architecture" | "Learnings" | "Guidelines";
  lastModified: string;
  author: string;
  content: string;
}

const SAMPLE_DOCS: WikiDoc[] = [
  {
    id: "doc-1",
    title: "Company Charter & Operating Manifesto",
    category: "Strategic",
    lastModified: "2 hours ago",
    author: "Trent CEO",
    content: "# Company Charter\n\nTrent operates as an autonomous, multi-agent cofounder system. High-leverage execution, strict budget cap enforcement, and continuous self-improvement guide all autonomous decisions.",
  },
  {
    id: "doc-2",
    title: "System Architecture & Isolation Boundaries",
    category: "Architecture",
    lastModified: "Yesterday",
    author: "Lead Engineer",
    content: "# Architecture Guide\n\nEgress credential proxy isolates API keys from Docker sandboxes. All mutated operations on production assets (DNS, social, payments) require explicit approval gate signoff.",
  },
  {
    id: "doc-3",
    title: "Distilled Self-Improvement Skills (GEPA)",
    category: "Learnings",
    lastModified: "3 hours ago",
    author: "Skill Foundry",
    content: "# Distilled Skill: TypeScript Monorepo Build Optimization\n\nWhen running build commands across symlinked workspaces, ensure tsconfig paths are resolved from project roots to prevent duplicate type declarations.",
  },
];

export const WikiView: React.FC = () => {
  const [docs, setDocs] = useState<WikiDoc[]>(SAMPLE_DOCS);
  const [selectedDoc, setSelectedDoc] = useState<WikiDoc>(SAMPLE_DOCS[0]);
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");

  const handleCreateDoc = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    const doc: WikiDoc = {
      id: `doc-${Date.now()}`,
      title: newTitle,
      category: "Guidelines",
      lastModified: "Just now",
      author: "Trent CEO",
      content: newContent || "# " + newTitle,
    };

    setDocs([doc, ...docs]);
    setSelectedDoc(doc);
    setIsAdding(false);
    setNewTitle("");
    setNewContent("");
  };

  return (
    <div className="flex-1 flex flex-col bg-[#0F1117] overflow-hidden">
      {/* Header */}
      <div className="h-14 border-b border-[#262B3B] px-6 flex items-center justify-between bg-[#161922]">
        <div className="flex items-center gap-3">
          <BookOpen className="w-5 h-5 text-[#8B5CF6]" />
          <div>
            <h2 className="text-sm font-bold text-white tracking-wide">
              WIKI & PERSISTENT MEMORY GRAPH
            </h2>
            <p className="text-[11px] text-gray-400">
              Shared context memory across all 164 specialists · Drag-and-drop file ingestion
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-xs font-semibold transition shadow-lg shadow-purple-900/30"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Knowledge Document</span>
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Document Sidebar */}
        <div className="w-80 border-r border-[#262B3B] flex flex-col bg-[#161922]">
          <div className="p-3 border-b border-[#262B3B] flex items-center justify-between">
            <span className="text-xs font-bold text-gray-400 uppercase font-mono">
              Documents ({docs.length})
            </span>
            <div className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono">
              <Sparkles className="w-3 h-3" />
              <span>GEPA Synced</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {docs.map((d) => {
              const isSelected = selectedDoc.id === d.id;
              return (
                <div
                  key={d.id}
                  onClick={() => {
                    setSelectedDoc(d);
                    setIsAdding(false);
                  }}
                  className={`p-3 rounded-lg border cursor-pointer transition ${
                    isSelected
                      ? "bg-[#1F2432] border-[#8B5CF6]"
                      : "bg-[#0F1117] border-[#262B3B] hover:border-gray-600"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-[#8B5CF6]" />
                    <span className="text-xs font-bold text-white truncate">
                      {d.title}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-2 text-[10px] text-gray-400 font-mono">
                    <span>{d.category}</span>
                    <span>{d.lastModified}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Drag & Drop Upload Zone */}
          <div className="p-4 border-t border-[#262B3B] bg-[#0F1117]">
            <div className="border-2 border-dashed border-[#262B3B] hover:border-[#8B5CF6] rounded-lg p-4 text-center cursor-pointer transition">
              <Upload className="w-5 h-5 text-gray-400 mx-auto mb-1" />
              <div className="text-xs text-gray-300 font-semibold">Drop files here</div>
              <div className="text-[10px] text-gray-500">PDF, Markdown, TXT, JSON</div>
            </div>
          </div>
        </div>

        {/* Content Viewer / Editor */}
        <div className="flex-1 p-8 overflow-y-auto bg-[#0F1117]">
          {isAdding ? (
            <form onSubmit={handleCreateDoc} className="space-y-4 max-w-2xl">
              <h3 className="text-base font-bold text-white">Create Knowledge Document</h3>
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">
                  Title:
                </label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Q3 Growth Playbook..."
                  className="w-full bg-[#161922] border border-[#262B3B] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#8B5CF6]"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1">
                  Markdown Content:
                </label>
                <textarea
                  rows={12}
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Write knowledge document in markdown..."
                  className="w-full bg-[#161922] border border-[#262B3B] rounded-lg p-3 text-xs text-white font-mono placeholder-gray-500 focus:outline-none focus:border-[#8B5CF6]"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="px-4 py-2 bg-[#8B5CF6] hover:bg-[#7C3AED] text-white rounded-lg text-xs font-bold transition"
                >
                  Save Document
                </button>
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="px-4 py-2 bg-gray-800 text-gray-300 rounded-lg text-xs transition"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="max-w-3xl space-y-6">
              <div className="border-b border-[#262B3B] pb-4">
                <div className="flex items-center gap-2 text-xs font-mono text-[#8B5CF6] mb-1">
                  <Folder className="w-3.5 h-3.5" />
                  <span>{selectedDoc.category}</span>
                </div>
                <h1 className="text-2xl font-bold text-white tracking-tight">
                  {selectedDoc.title}
                </h1>
                <div className="text-xs text-gray-400 mt-2 font-mono">
                  Author: <span className="text-gray-300">{selectedDoc.author}</span> · Updated: {selectedDoc.lastModified}
                </div>
              </div>

              <div className="prose prose-invert max-w-none text-sm text-gray-300 leading-relaxed font-sans whitespace-pre-wrap">
                {selectedDoc.content}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
