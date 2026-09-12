"use client";

/**
 * Vault — Trent's company memory.
 *
 *  ┌──────────────────────────────────────────────────────────────┐
 *  │  VAULT HEADER  · graph view · search · upload · new note     │
 *  ├───────────────┬──────────────────────────────┬───────────────┤
 *  │               │                              │               │
 *  │  FILE TREE    │   MARKDOWN EDITOR / VIEW     │   BACKLINKS   │
 *  │  (folders +   │   (split preview, tags,      │   + TAGS      │
 *  │   notes)      │   linked [[notes]])          │   + graph     │
 *  │               │                              │               │
 *  └───────────────┴──────────────────────────────┴───────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I } from "@/components/ui";

type Note = {
  id: string;
  path: string;
  folder: string;
  slug: string;
  title: string;
  excerpt: string;
  tags: string[];
  outgoing: string[];
  backlinks: string[];
  updatedAt: string;
  contentLength: number;
};

type FullNote = Note & { content: string };

type TreeNode = {
  name: string;
  path: string;
  kind: "folder" | "note";
  children: TreeNode[];
  noteId?: string;
  noteTitle?: string;
};

type Graph = {
  nodes: Array<{ id: string; title: string; degree: number }>;
  edges: Array<{ from: string; to: string }>;
};

type ViewMode = "edit" | "preview" | "split" | "graph";

export function VaultClient({ companyId }: { companyId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [activeNote, setActiveNote] = useState<FullNote | null>(null);
  const [editedContent, setEditedContent] = useState("");
  const [editedTitle, setEditedTitle] = useState("");
  const [editedPath, setEditedPath] = useState("");
  const [view, setView] = useState<ViewMode>("split");
  const [search, setSearch] = useState("");
  const [showGraph, setShowGraph] = useState(false);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [askQuery, setAskQuery] = useState("");
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Loaders ───────────────────────────────────────────────────

  const load = useCallback(async () => {
    const res = await fetch(`/api/companies/${companyId}/wiki-notes`);
    if (res.ok) {
      const data = await res.json() as { notes: Note[]; tree: TreeNode };
      setNotes(data.notes ?? []);
      setTree(data.tree ?? null);
    }
    setLoading(false);
  }, [companyId]);

  const loadNote = useCallback(async (id: string) => {
    const res = await fetch(`/api/companies/${companyId}/wiki-notes?note=${id}`);
    if (res.ok) {
      const data = await res.json() as { note: FullNote };
      setActiveNote(data.note);
      setEditedContent(data.note.content);
      setEditedTitle(data.note.title);
      setEditedPath(data.note.path);
    }
  }, [companyId]);

  const loadGraph = useCallback(async () => {
    const res = await fetch(`/api/companies/${companyId}/wiki-notes?view=graph`);
    if (res.ok) {
      const data = await res.json() as { graph: Graph };
      setGraph(data.graph);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  // ── Actions ──────────────────────────────────────────────────

  async function saveNote() {
    if (!editedTitle.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/wiki-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: activeNote?.id,
          title: editedTitle.trim(),
          path: editedPath || `/${editedTitle.trim()}`,
          content: editedContent,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { note: FullNote };
        setActiveNote(data.note);
        await load();
      }
    } finally {
      setSaving(false);
    }
  }

  async function newNote(folder: string = "/") {
    const title = "New note";
    const path = `${folder}/${Date.now()}`.replace("//", "/");
    const res = await fetch(`/api/companies/${companyId}/wiki-notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, path, content: `# ${title}\n\nWrite here. Link other notes with [[Note Title]]. Tag with #important.` }),
    });
    if (res.ok) {
      const data = await res.json() as { note: FullNote };
      await load();
      await loadNote(data.note.id);
    }
  }

  async function deleteCurrent() {
    if (!activeNote) return;
    if (!confirm(`Delete "${activeNote.title}"?`)) return;
    await fetch(`/api/companies/${companyId}/wiki-notes?note=${activeNote.id}`, { method: "DELETE" });
    setActiveNote(null);
    await load();
  }

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("folder", activeNote?.folder ?? "/");
      const res = await fetch(`/api/companies/${companyId}/wiki-notes/upload`, { method: "POST", body: fd });
      if (res.ok) {
        const data = await res.json() as { note: FullNote };
        await load();
        await loadNote(data.note.id);
      }
    } finally {
      setUploading(false);
    }
  }

  async function askVault() {
    const q = askQuery.trim();
    if (!q || asking) return;
    setAsking(true);
    setAskAnswer(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/wiki/semantic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, k: 6 }),
      });
      if (res.ok) {
        const data = await res.json() as { answer: { answer: string; refusal?: string; citations?: Array<{ idx: number; title: string }> } };
        if (data.answer?.refusal) {
          setAskAnswer(data.answer.refusal);
        } else {
          const cites = (data.answer?.citations ?? []).map((c) => `[#${c.idx}] ${c.title}`).join(" · ");
          setAskAnswer(`${data.answer.answer}\n\n${cites ? `Cited: ${cites}` : ""}`.trim());
        }
      }
    } finally {
      setAsking(false);
    }
  }

  function toggleFolder(p: string) {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  // ── Derived ──────────────────────────────────────────────────

  const filteredNotes = useMemo(() => {
    if (!search.trim()) return notes;
    const q = search.toLowerCase();
    return notes.filter((n) =>
      n.title.toLowerCase().includes(q) ||
      n.excerpt.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [notes, search]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [notes]);

  const previewHtml = useMemo(() => renderMarkdown(editedContent, (target) => {
    const t = notes.find((n) => n.title.toLowerCase() === target.toLowerCase());
    if (t) return { href: `#note-${t.id}`, exists: true };
    return { href: "#missing", exists: false };
  }), [editedContent, notes]);

  const dirty = activeNote != null && (
    editedContent !== activeNote.content ||
    editedTitle !== activeNote.title ||
    editedPath !== activeNote.path
  );

  function onEditorKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty && !saving) void saveNote();
    }
  }

  if (loading) {
    return (
      <div data-testid="vault-loading" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 400 }}>
        <div className="spinner" style={{ width: 22, height: 22, borderWidth: 2 }} />
      </div>
    );
  }

  return (
    <div data-testid="vault" style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: "calc(100vh - 220px)" }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "14px 18px", borderRadius: 14,
        background: "var(--ink)", border: "1px solid rgba(255,255,255,.07)",
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 9,
          background: "rgba(110,231,183,.10)", border: "1px solid rgba(110,231,183,.28)",
          display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pulse)",
        }}>◈</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)" }}>
            company memory · {notes.length} notes · {tagCounts.length} tags
          </div>
          <div style={{ fontSize: 14, color: "var(--bone)", fontWeight: 500 }}>
            {activeNote ? activeNote.path : "Knowledge map for your company"}
          </div>
        </div>

        <input
          data-testid="vault-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search notes · titles, content, tags"
          className="input"
          style={{ width: 260, fontSize: 12, height: 34 }}
        />
        <button
          data-testid="upload-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{
            padding: "7px 14px", height: 34, borderRadius: 8,
            background: "var(--steel)", color: "var(--bone-2)",
            border: "1px solid rgba(255,255,255,.08)",
            fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          {uploading ? "uploading…" : "↑ upload"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt,.pdf,.json,.csv,.yaml,.yml"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }}
        />
        <button
          data-testid="graph-btn"
          onClick={() => { setShowGraph(true); void loadGraph(); }}
          style={{
            padding: "7px 14px", height: 34, borderRadius: 8,
            background: "var(--steel)", color: "var(--bone-2)",
            border: "1px solid rgba(255,255,255,.08)",
            fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          ⊕ graph
        </button>
        <button
          data-testid="new-note-btn"
          onClick={() => newNote("/")}
          style={{
            padding: "7px 16px", height: 34, borderRadius: 8,
            background: "var(--pulse)", color: "#0A0A0F", border: 0,
            fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
            cursor: "pointer", fontWeight: 600,
          }}
        >
          + note
        </button>
      </div>

      {/* ── 3-pane workspace ───────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr 280px", gap: 12, flex: 1, minHeight: 540 }}>
        {/* Tree pane */}
        <div style={{
          background: "var(--ink)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 14,
          padding: 12, overflowY: "auto", maxHeight: "calc(100vh - 240px)",
        }}>
          <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 10, padding: "0 6px" }}>
            vault
          </div>
          {tree && tree.children.length > 0 ? (
            <Tree node={tree} depth={0} activeNoteId={activeNote?.id} onSelect={loadNote} collapsed={collapsed} onToggle={toggleFolder} />
          ) : (
            <div style={{ padding: 14, fontSize: 11, color: "var(--haze)", textAlign: "center" }}>
              No notes yet. Click <strong style={{ color: "var(--pulse)" }}>+ note</strong> or <strong style={{ color: "var(--pulse)" }}>↑ upload</strong>.
            </div>
          )}

          {filteredNotes.length > 0 && search.trim() && (
            <div style={{ marginTop: 14, borderTop: "1px dashed rgba(255,255,255,.06)", paddingTop: 12 }}>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", color: "var(--pulse)", marginBottom: 8, padding: "0 6px" }}>
                search · {filteredNotes.length}
              </div>
              {filteredNotes.slice(0, 30).map((n) => (
                <button
                  key={n.id}
                  onClick={() => loadNote(n.id)}
                  style={{
                    display: "block", width: "100%", textAlign: "left",
                    padding: "6px 8px", borderRadius: 6,
                    background: activeNote?.id === n.id ? "rgba(110,231,183,.06)" : "transparent",
                    border: 0, color: "var(--bone-2)", fontSize: 12, cursor: "pointer", marginBottom: 1,
                  }}
                >
                  <div>{n.title}</div>
                  <div className="mono" style={{ fontSize: 9, color: "var(--haze)" }}>{n.path}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Editor pane */}
        <div style={{
          background: "var(--ink)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 14,
          display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0,
        }}>
          {activeNote ? (
            <>
              <div style={{
                display: "flex", alignItems: "center", gap: 8, padding: "12px 14px",
                borderBottom: "1px solid rgba(255,255,255,.06)", flexWrap: "wrap",
              }}>
                <input
                  data-testid="note-title-input"
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                  onKeyDown={onEditorKeyDown}
                  style={{
                    background: "transparent", border: 0, outline: 0,
                    color: "var(--bone)", fontSize: 17, fontWeight: 600, flex: 1, minWidth: 200,
                  }}
                />
                <input
                  data-testid="note-path-input"
                  value={editedPath}
                  onChange={(e) => setEditedPath(e.target.value)}
                  className="input mono"
                  style={{ fontSize: 10, width: 200, height: 28 }}
                />
                <div style={{ display: "inline-flex", background: "var(--steel)", borderRadius: 7, padding: 2, border: "1px solid rgba(255,255,255,.06)" }}>
                  {(["edit", "split", "preview"] as ViewMode[]).map((m) => (
                    <button
                      key={m}
                      data-testid={`view-${m}`}
                      onClick={() => setView(m)}
                      className="mono"
                      style={{
                        padding: "5px 10px", border: 0,
                        background: view === m ? "rgba(110,231,183,.1)" : "transparent",
                        color: view === m ? "var(--pulse)" : "var(--haze)",
                        fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase",
                        borderRadius: 5, cursor: "pointer",
                      }}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <button
                  data-testid="save-note-btn"
                  onClick={saveNote}
                  disabled={saving || !dirty}
                  title="Save  ⌘S"
                  aria-label={dirty ? "Save note" : "Saved"}
                  style={{
                    padding: "0 12px", height: 30, borderRadius: 7,
                    background: dirty ? "var(--pulse)" : "rgba(255,255,255,.05)",
                    color: dirty ? "var(--obsidian)" : "var(--haze)", border: 0,
                    fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase",
                    cursor: saving || !dirty ? "default" : "pointer", fontWeight: 600,
                    transition: "background .18s ease, color .18s ease",
                  }}
                >
                  {saving ? "…" : dirty ? "save" : "saved"}
                </button>
                <button
                  onClick={deleteCurrent}
                  title="Delete note"
                  aria-label="Delete note"
                  style={{
                    padding: "0 10px", height: 30, borderRadius: 7,
                    background: "transparent", color: "var(--haze)", border: "1px solid rgba(255,255,255,.08)",
                    fontFamily: "var(--mono)", fontSize: 13, cursor: "pointer",
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ flex: 1, overflow: "hidden", display: "grid", gridTemplateColumns: view === "split" ? "1fr 1fr" : "1fr" }}>
                {(view === "edit" || view === "split") && (
                  <textarea
                    data-testid="note-content-input"
                    value={editedContent}
                    onChange={(e) => setEditedContent(e.target.value)}
                    onKeyDown={onEditorKeyDown}
                    placeholder="Write here. Link notes with [[Title]]. Tag with #topic. ⌘S to save."
                    style={{
                      background: "transparent", border: 0, outline: 0, resize: "none",
                      padding: 18, color: "var(--bone-2)", fontSize: 13, lineHeight: 1.7,
                      fontFamily: "var(--mono)", height: "100%", minHeight: 320,
                      borderRight: view === "split" ? "1px solid rgba(255,255,255,.06)" : "none",
                    }}
                  />
                )}
                {(view === "preview" || view === "split") && (
                  <div
                    data-testid="note-preview"
                    className="vault-preview"
                    style={{
                      padding: 18, overflowY: "auto",
                      color: "var(--bone-2)", fontSize: 14, lineHeight: 1.7,
                    }}
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                )}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 40, textAlign: "center", color: "var(--haze)", fontSize: 13 }}>
              <div>
                <div style={{ fontSize: 36, marginBottom: 14 }}>◊</div>
                <div style={{ fontSize: 16, color: "var(--bone)", marginBottom: 8 }}>Pick a note, or upload one.</div>
                <div style={{ fontSize: 12, color: "var(--mist)", maxWidth: 360, margin: "0 auto" }}>
                  Drop in PDFs, markdown, CSVs, or JSON. Link notes with <code style={{ color: "var(--pulse)" }}>[[Title]]</code>. Tag with <code style={{ color: "var(--pulse)" }}>#topic</code>.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right rail */}
        <div style={{
          background: "var(--ink)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 14,
          padding: 14, overflowY: "auto", maxHeight: "calc(100vh - 240px)",
          display: "flex", flexDirection: "column", gap: 18,
        }}>
          {/* Ask the vault */}
          <div>
            <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 8 }}>
              ask the vault
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={askQuery}
                onChange={(e) => setAskQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void askVault(); }}
                placeholder="ask with citations"
                className="input"
                style={{ flex: 1, fontSize: 11, height: 30 }}
              />
              <button
                onClick={askVault}
                disabled={asking}
                style={{
                  padding: "0 10px", height: 30, borderRadius: 6,
                  background: "rgba(110,231,183,.10)", border: "1px solid rgba(110,231,183,.28)",
                  color: "var(--pulse)", fontSize: 10, fontFamily: "var(--mono)", letterSpacing: ".12em", cursor: "pointer",
                }}
              >
                {asking ? "…" : "ask"}
              </button>
            </div>
            {askAnswer && (
              <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.06)", fontSize: 12, color: "var(--bone-2)", lineHeight: 1.55 }}>
                {askAnswer}
              </div>
            )}
          </div>

          {/* Backlinks */}
          {activeNote && (
            <div>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 8 }}>
                backlinks · {activeNote.backlinks.length}
              </div>
              {activeNote.backlinks.length === 0 ? (
                <div style={{ fontSize: 11, color: "var(--haze)", padding: 6 }}>No notes link here.</div>
              ) : activeNote.backlinks.map((b) => {
                const target = notes.find((n) => n.title === b);
                return (
                  <button
                    key={b}
                    onClick={() => target && loadNote(target.id)}
                    style={{
                      display: "block", width: "100%", textAlign: "left",
                      padding: "6px 8px", borderRadius: 6,
                      background: "transparent", border: 0,
                      color: "var(--pulse)", fontSize: 12, cursor: "pointer", marginBottom: 2,
                    }}
                  >
                    [[{b}]]
                  </button>
                );
              })}
            </div>
          )}

          {/* Outgoing links */}
          {activeNote && activeNote.outgoing.length > 0 && (
            <div>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 8 }}>
                outgoing · {activeNote.outgoing.length}
              </div>
              {activeNote.outgoing.map((b) => {
                const target = notes.find((n) => n.title.toLowerCase() === b.toLowerCase());
                return (
                  <button
                    key={b}
                    onClick={() => target ? loadNote(target.id) : newNote()}
                    style={{
                      display: "block", width: "100%", textAlign: "left",
                      padding: "6px 8px", borderRadius: 6,
                      background: "transparent", border: 0,
                      color: target ? "var(--bone-2)" : "#FB923C",
                      fontSize: 12, cursor: "pointer", marginBottom: 2,
                    }}
                  >
                    {target ? `[[${b}]]` : `[[${b}]] (create)`}
                  </button>
                );
              })}
            </div>
          )}

          {/* Tags */}
          {tagCounts.length > 0 && (
            <div>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 8 }}>
                tags
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {tagCounts.slice(0, 30).map(([t, n]) => (
                  <button
                    key={t}
                    onClick={() => setSearch(`#${t}`)}
                    className="mono"
                    style={{
                      padding: "3px 7px", borderRadius: 999,
                      background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.06)",
                      color: "var(--mist)", fontSize: 10, letterSpacing: ".06em", cursor: "pointer",
                    }}
                  >
                    #{t} <span style={{ color: "var(--haze)" }}>· {n}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Graph modal */}
      {showGraph && (
        <GraphModal graph={graph} onClose={() => setShowGraph(false)} onSelect={(id) => { setShowGraph(false); void loadNote(id); }} />
      )}

      {/* Markdown styling */}
      <style jsx global>{`
        .vault-preview h1 { font-size: 24px; color: var(--bone); margin: 0 0 14px; font-weight: 600; }
        .vault-preview h2 { font-size: 18px; color: var(--bone); margin: 22px 0 10px; font-weight: 600; }
        .vault-preview h3 { font-size: 15px; color: var(--bone); margin: 18px 0 8px; font-weight: 600; }
        .vault-preview p { margin: 0 0 12px; }
        .vault-preview a { color: var(--pulse); text-decoration: none; border-bottom: 1px dashed rgba(110,231,183,.4); }
        .vault-preview a.missing { color: #FB923C; border-bottom-style: dotted; }
        .vault-preview ul, .vault-preview ol { padding-left: 22px; margin: 0 0 12px; }
        .vault-preview li { margin: 4px 0; }
        .vault-preview code { background: rgba(255,255,255,.06); padding: 1px 5px; border-radius: 4px; font-family: var(--mono); font-size: 12px; color: var(--pulse); }
        .vault-preview pre { background: #0a0a0f; border: 1px solid rgba(255,255,255,.05); padding: 12px; border-radius: 8px; overflow-x: auto; }
        .vault-preview pre code { background: transparent; padding: 0; color: var(--bone-2); }
        .vault-preview blockquote { border-left: 3px solid rgba(110,231,183,.3); padding-left: 12px; margin: 0 0 12px; color: var(--mist); font-style: italic; }
        .vault-preview .vault-tag { color: var(--pulse); }
      `}</style>
    </div>
  );
}

// ── Sub: tree rendering ──────────────────────────────────────────────────────

function Tree({ node, depth, activeNoteId, onSelect, collapsed, onToggle }: {
  node: TreeNode;
  depth: number;
  activeNoteId?: string;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggle: (p: string) => void;
}) {
  return (
    <>
      {node.children.map((c) => (
        <TreeNodeRow
          key={`${c.kind}:${c.path}:${c.noteId ?? ""}`}
          node={c}
          depth={depth}
          activeNoteId={activeNoteId}
          onSelect={onSelect}
          collapsed={collapsed}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

function TreeNodeRow({ node, depth, activeNoteId, onSelect, collapsed, onToggle }: {
  node: TreeNode;
  depth: number;
  activeNoteId?: string;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggle: (p: string) => void;
}) {
  if (node.kind === "note") {
    const active = activeNoteId === node.noteId;
    return (
      <button
        data-testid={`vault-note-${node.path}`}
        onClick={() => node.noteId && onSelect(node.noteId)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          width: "100%", padding: `5px 8px 5px ${10 + depth * 12}px`,
          borderRadius: 6, background: active ? "rgba(110,231,183,.06)" : "transparent",
          border: 0, color: active ? "var(--pulse)" : "var(--bone-2)",
          fontSize: 12, textAlign: "left", cursor: "pointer", marginBottom: 1,
        }}
      >
        <span style={{ color: active ? "var(--pulse)" : "var(--haze)", fontSize: 11 }}>·</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.noteTitle ?? node.name}
        </span>
      </button>
    );
  }
  const isCollapsed = collapsed.has(node.path);
  return (
    <div>
      <button
        onClick={() => onToggle(node.path)}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          width: "100%", padding: `5px 8px 5px ${10 + depth * 12}px`,
          borderRadius: 6, background: "transparent", border: 0,
          color: "var(--mist)", fontSize: 12, textAlign: "left", cursor: "pointer",
          fontWeight: 500, marginBottom: 1,
        }}
      >
        <span style={{ color: "var(--haze)", transform: isCollapsed ? "rotate(-90deg)" : "rotate(0)", transition: "transform .15s", display: "inline-block" }}>▾</span>
        <span style={{ flex: 1 }}>{node.name}</span>
        <span className="mono" style={{ fontSize: 9, color: "var(--haze)" }}>{countNotes(node)}</span>
      </button>
      {!isCollapsed && node.children.map((c) => (
        <TreeNodeRow
          key={`${c.kind}:${c.path}:${c.noteId ?? ""}`}
          node={c}
          depth={depth + 1}
          activeNoteId={activeNoteId}
          onSelect={onSelect}
          collapsed={collapsed}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function countNotes(node: TreeNode): number {
  if (node.kind === "note") return 1;
  return node.children.reduce((s, c) => s + countNotes(c), 0);
}

// ── Sub: graph modal ────────────────────────────────────────────────────────

function GraphModal({ graph, onClose, onSelect }: {
  graph: Graph | null;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Simple force-direction-style layout: distribute nodes around a circle
  const layout = useMemo(() => {
    if (!graph) return null;
    const w = 640, h = 480, cx = w / 2, cy = h / 2;
    const ringRadius = Math.min(w, h) * 0.36;
    const positions = new Map<string, { x: number; y: number }>();
    graph.nodes.forEach((n, i) => {
      const angle = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      const r = ringRadius * (0.7 + Math.min(0.3, n.degree * 0.08));
      positions.set(n.id, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    });
    return { w, h, positions };
  }, [graph]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,.6)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 40,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(720px, 100%)", maxHeight: "min(640px, 100%)", padding: 24, borderRadius: 18,
        background: "var(--ink)", border: "1px solid rgba(255,255,255,.1)",
        boxShadow: "0 32px 70px rgba(0,0,0,.55)",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)" }}>knowledge graph</div>
            <div style={{ fontSize: 16, color: "var(--bone)", marginTop: 4 }}>{graph?.nodes.length ?? 0} notes · {graph?.edges.length ?? 0} links</div>
          </div>
          <button onClick={onClose} aria-label="Close graph" title="Close  Esc" style={{ background: "transparent", border: 0, color: "var(--haze)", cursor: "pointer", fontSize: 22 }}>×</button>
        </div>

        {!graph || !layout ? (
          <div style={{ textAlign: "center", color: "var(--haze)", padding: 40 }}>Loading graph…</div>
        ) : graph.nodes.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--haze)", padding: 40 }}>No notes yet.</div>
        ) : (
          <svg viewBox={`0 0 ${layout.w} ${layout.h}`} style={{ width: "100%", height: "auto", border: "1px solid rgba(255,255,255,.06)", borderRadius: 12, background: "#06070b" }}>
            {graph.edges.map((e, i) => {
              const a = layout.positions.get(e.from); const b = layout.positions.get(e.to);
              if (!a || !b) return null;
              return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(110,231,183,.22)" strokeWidth={1} />;
            })}
            {graph.nodes.map((n) => {
              const p = layout.positions.get(n.id)!;
              const r = 6 + Math.min(14, n.degree * 1.6);
              return (
                <g key={n.id} style={{ cursor: "pointer" }} onClick={() => onSelect(n.id)}>
                  <circle cx={p.x} cy={p.y} r={r} fill="rgba(110,231,183,.18)" stroke="rgba(110,231,183,.5)" strokeWidth={1.4} />
                  <text x={p.x} y={p.y + r + 12} textAnchor="middle" fill="var(--bone-2)" fontSize={11} fontFamily="var(--mono)">{n.title.slice(0, 18)}</text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}

// ── Markdown renderer (lightweight, no external dep) ─────────────────────────

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMarkdown(src: string, resolveLink: (target: string) => { href: string; exists: boolean }): string {
  if (!src) return "<p style='color:var(--haze)'>(empty note)</p>";
  let html = escapeHtml(src);

  // Code fences ```lang ... ```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => `<pre><code>${code}</code></pre>`);

  // Headings
  html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");

  // Bold/italic
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

  // Wiki links [[...]]
  html = html.replace(/\[\[([^\]|]+?)(\|[^\]]+)?\]\]/g, (_, target) => {
    const r = resolveLink(target.trim());
    return `<a class="${r.exists ? "" : "missing"}" href="${r.href}">${target}</a>`;
  });

  // Standard links [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Tags #foo
  html = html.replace(/(^|\s)#([a-zA-Z][\w-]+)/g, '$1<span class="vault-tag">#$2</span>');

  // Lists (bullet only — simple)
  html = html.replace(/((?:^[-*] .+(?:\n|$))+)/gm, (m) => {
    const items = m.trim().split(/\n/).map((line) => `<li>${line.replace(/^[-*] /, "")}</li>`).join("");
    return `<ul>${items}</ul>`;
  });

  // Numbered lists
  html = html.replace(/((?:^\d+\. .+(?:\n|$))+)/gm, (m) => {
    const items = m.trim().split(/\n/).map((line) => `<li>${line.replace(/^\d+\. /, "")}</li>`).join("");
    return `<ol>${items}</ol>`;
  });

  // Paragraphs: split on blank lines, wrap non-block elements
  const blocks = html.split(/\n{2,}/).map((b) => {
    if (/^\s*<(h\d|ul|ol|pre|blockquote)/.test(b)) return b;
    return `<p>${b.replace(/\n/g, "<br />")}</p>`;
  });

  return blocks.join("\n");
}
