"use client";

import React, { useEffect } from "react";
import { Command } from "cmdk";

export type PaletteSession = { id: string; objective: string; status: string; agentMode: string };

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

/**
 * ⌘K spotlight for the Workbench. Jump between sessions and fire the common
 * build actions without leaving the keyboard — the a competing platform-style command bar.
 */
export function WorkbenchCommandPalette({
  open,
  onOpenChange,
  sessions,
  activeId,
  onSelectSession,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: PaletteSession[];
  activeId: string | null;
  onSelectSession: (id: string) => void;
  actions: PaletteAction[];
}) {
  // Global ⌘K / Ctrl+K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div style={S.overlay} onClick={() => onOpenChange(false)}>
      <div style={S.panel} onClick={(e) => e.stopPropagation()}>
        <style>{PALETTE_CSS}</style>
        <Command label="Workbench command palette" style={S.command} loop>
          <Command.Input autoFocus placeholder="Search sessions and actions…" style={S.input} className="mono" />
          <Command.List style={S.list}>
            <Command.Empty style={S.empty}>No matches.</Command.Empty>

            {actions.length > 0 && (
              <Command.Group heading="Actions" style={S.group}>
                {actions.map((action) => (
                  <Command.Item
                    key={action.id}
                    value={`action ${action.label} ${action.hint ?? ""}`}
                    onSelect={() => { onOpenChange(false); action.run(); }}
                    style={S.item}
                  >
                    <span>{action.label}</span>
                    {action.hint ? <span className="mono" style={S.itemHint}>{action.hint}</span> : null}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {sessions.length > 0 && (
              <Command.Group heading="Sessions" style={S.group}>
                {sessions.map((session) => (
                  <Command.Item
                    key={session.id}
                    value={`session ${session.objective} ${session.agentMode} ${session.id}`}
                    onSelect={() => { onOpenChange(false); onSelectSession(session.id); }}
                    style={S.item}
                  >
                    <span style={S.itemTitle}>{session.objective}</span>
                    <span className="mono" style={S.itemHint}>
                      {session.agentMode} · {session.status}{session.id === activeId ? " · active" : ""}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

const PALETTE_CSS = `
[cmdk-item][data-selected="true"] { background: rgba(110,231,183,.1); color: var(--bone); }
[cmdk-item] { transition: background .08s ease; }
[cmdk-group-heading] { padding: 6px 12px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--haze); }
`;

const border = "1px solid rgba(255,255,255,.08)";

const S = {
  overlay: { position: "fixed", inset: 0, zIndex: 60, background: "rgba(4,6,9,.62)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "14vh" } as React.CSSProperties,
  panel: { width: "min(560px, 92vw)", maxHeight: "62vh", borderRadius: 14, border, background: "var(--obsidian)", boxShadow: "0 24px 60px rgba(0,0,0,.5)", overflow: "hidden" } as React.CSSProperties,
  command: { display: "flex", flexDirection: "column", minHeight: 0, maxHeight: "62vh" } as React.CSSProperties,
  input: { width: "100%", boxSizing: "border-box", padding: "16px 18px", border: "none", borderBottom: border, background: "transparent", color: "var(--bone)", fontSize: 14, outline: "none" } as React.CSSProperties,
  list: { overflowY: "auto", padding: 8, minHeight: 0 } as React.CSSProperties,
  empty: { padding: "18px 12px", color: "var(--haze)", fontSize: 13, textAlign: "center" } as React.CSSProperties,
  group: { padding: "4px 4px 8px" } as React.CSSProperties,
  item: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 12px", borderRadius: 8, color: "var(--mist)", fontSize: 13, cursor: "pointer" } as React.CSSProperties,
  itemTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } as React.CSSProperties,
  itemHint: { color: "var(--haze)", fontSize: 11, whiteSpace: "nowrap", flexShrink: 0 } as React.CSSProperties,
};
