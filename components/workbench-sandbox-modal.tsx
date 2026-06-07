"use client";

import React, { useEffect, useMemo, useState } from "react";
import { AgentActivityFeed, CodeBlock, inferCodeBlock, mapWorkbenchEventsToSteps, type ActivityStep } from "@/components/agent-activity";
import { buildWorkbenchIdeView } from "@/lib/workbench-ide-view";

type SessionStatus = "queued" | "starting" | "running" | "paused" | "completed" | "failed" | "cancelled";
type SandboxTab = "preview" | "files" | "diff" | "terminal" | "tests" | "artifacts" | "screenshots";

type WbEvent = {
  id: string;
  type: string;
  status: string;
  title: string;
  content: string;
  command?: string;
  durationMs?: number;
  agentRole?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type WbArtifact = {
  id: string;
  kind: string;
  title: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  createdByAgent?: string;
  sourceEventId?: string;
  path?: string;
  previewUrl?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

type FileEntry = { name: string; path: string; isDir: boolean; sizeBytes: number; modifiedAt: string };
type DiffSummary = { changedPaths: string[]; summary: string; patch?: string; fromHash?: string; toHash?: string };

export const WORKBENCH_SANDBOX_TABS: { key: SandboxTab; label: string; title: string }[] = [
  { key: "preview", label: "Preview", title: "Live sandbox preview" },
  { key: "files", label: "Files", title: "Generated file tree and file viewer" },
  { key: "diff", label: "Diff", title: "Changes since the persisted checkpoint" },
  { key: "terminal", label: "Terminal", title: "Commands, outputs, and exit codes" },
  { key: "tests", label: "Tests", title: "Verification checks and failures" },
  { key: "artifacts", label: "Artifacts", title: "Captured files, logs, previews, and exports" },
  { key: "screenshots", label: "Screenshots", title: "Captured screenshots" },
];

export function WorkbenchSandboxModal({
  url,
  objective,
  status,
  sessionId,
  events = [],
  artifacts = [],
  activity = [],
  onRefreshSession,
  onClose,
}: {
  url: string;
  objective: string;
  status: SessionStatus;
  sessionId?: string;
  events?: WbEvent[];
  artifacts?: WbArtifact[];
  activity?: ActivityStep[];
  onRefreshSession?: () => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SandboxTab>("preview");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [diff, setDiff] = useState<DiffSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ideView = useMemo(
    () => buildWorkbenchIdeView({ events: events as never, artifacts: artifacts as never }),
    [events, artifacts]
  );
  const terminalSteps = useMemo(
    () => [
      ...mapWorkbenchEventsToSteps(ideView.terminalLines.map((line) => ({
        id: line.id,
        type: line.command ? "shell" : "event",
        title: line.title,
        content: line.content,
        command: line.command,
        status: line.status,
      }))),
      ...activity,
    ],
    [ideView.terminalLines, activity],
  );
  const selectedFileBlock = useMemo(
    () => (selectedFile ? inferCodeBlock(selectedFile, fileContent) : undefined),
    [selectedFile, fileContent],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!sessionId || tab !== "files") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/workbench/${sessionId}/files`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? "Failed to load files");
        return res.json() as Promise<{ files: FileEntry[] }>;
      })
      .then((body) => { if (!cancelled) setFiles(body.files ?? []); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load files"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, tab, events.length, artifacts.length]);

  useEffect(() => {
    if (!sessionId || tab !== "diff") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/workbench/${sessionId}/diff`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? "Failed to load diff");
        return res.json() as Promise<{ diff: DiffSummary }>;
      })
      .then((body) => { if (!cancelled) setDiff(body.diff ?? null); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load diff"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, tab, events.length, artifacts.length]);

  useEffect(() => {
    if (!sessionId || !selectedFile || tab !== "files") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/workbench/${sessionId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "read", path: selectedFile }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? "Failed to read file");
        return res.json() as Promise<{ content: string }>;
      })
      .then((body) => { if (!cancelled) setFileContent(body.content ?? ""); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to read file"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, selectedFile, tab]);

  const captureScreenshot = async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workbench/${sessionId}/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, width: 1440, height: 900 }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? "Screenshot failed");
      setTab("screenshots");
      await onRefreshSession?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Screenshot failed");
    } finally {
      setLoading(false);
    }
  };

  const exportBundle = async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workbench/${sessionId}/export`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? "Export failed");
      setTab("artifacts");
      await onRefreshSession?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="Sandbox preview" style={SB.backdrop}>
      <div onClick={(event) => event.stopPropagation()} style={SB.shell}>
        <div style={SB.head}>
          <div style={SB.titleGroup}>
            <StatusDot status={status} />
            <span className="mono" style={SB.kicker}>SANDBOX · LIVE BUILD</span>
            <span style={SB.objective}>{objective}</span>
          </div>
          <div style={SB.actions}>
            <a href={url} target="_blank" rel="noopener noreferrer" className="mono" style={SB.openTab} title="Open in a new tab">open</a>
            <button onClick={onClose} aria-label="Close sandbox" title="Close Esc" style={SB.close}>x</button>
          </div>
        </div>
        <div className="mono" style={SB.urlbar}>{url}</div>
        <nav aria-label="Workbench tabs" style={SB.tabs}>
          {WORKBENCH_SANDBOX_TABS.map((item) => (
            <button key={item.key} type="button" onClick={() => setTab(item.key)} title={item.title} style={SB.tab(tab === item.key)}>
              {item.label}
            </button>
          ))}
        </nav>
        {error && <div style={SB.error}>{error}</div>}
        <div style={SB.body}>
          {tab === "preview" && (
            <div style={SB.previewPane}>
              <iframe src={url} title="sandbox" style={SB.frame} sandbox="allow-scripts allow-same-origin allow-forms" />
              <div style={SB.previewActions}>
                <button type="button" onClick={() => void captureScreenshot()} disabled={!sessionId || loading} style={SB.actionBtn}>
                  {loading ? "Capturing..." : "Capture screenshot"}
                </button>
                <button type="button" onClick={() => void exportBundle()} disabled={!sessionId || loading} style={SB.actionBtn}>
                  {loading ? "Exporting..." : "Export bundle"}
                </button>
              </div>
            </div>
          )}
          {tab === "files" && (
            <div style={SB.splitPane}>
              <div style={SB.listPane}>
                {files.length === 0 && <span style={SB.muted}>{loading ? "Loading files..." : "No files loaded yet."}</span>}
                {files.map((file) => (
                  <button key={file.path} type="button" disabled={file.isDir} onClick={() => setSelectedFile(file.path)} style={SB.fileBtn(selectedFile === file.path, file.isDir)} title={file.path}>
                    {file.isDir ? ">" : "-"} {file.path}
                  </button>
                ))}
              </div>
              {selectedFileBlock ? (
                <CodeBlock block={selectedFileBlock} defaultCollapsed={false} />
              ) : (
                <div style={SB.muted}>{selectedFile ? "Loading file..." : "Select a file to inspect it."}</div>
              )}
            </div>
          )}
          {tab === "diff" && (
            <div style={SB.panel}>
              <p style={SB.text}>{diff?.summary ?? (loading ? "Loading diff..." : "No diff loaded yet.")}</p>
              <div style={SB.chipList}>{(diff?.changedPaths ?? []).map((path) => <span key={path} style={SB.pathChip}>{path}</span>)}</div>
              {diff?.patch ? <CodeBlock block={{ content: diff.patch, language: "diff", mode: "diff", filename: "changes.patch" }} /> : null}
            </div>
          )}
          {tab === "terminal" && (
            terminalSteps.length === 0
              ? <span style={SB.muted}>No terminal output yet.</span>
              : <AgentActivityFeed steps={terminalSteps} aria-label="Sandbox terminal activity" />
          )}
          {tab === "tests" && (
            <div style={SB.panel}>
              {ideView.verifyChecks.length === 0 && <span style={SB.muted}>No verification checks recorded yet.</span>}
              {ideView.verifyChecks.map((check) => (
                <div key={`${check.name}-${check.detail}`} style={SB.checkRow(check.status)}>
                  <span className="mono">{check.status}</span>
                  <strong>{check.name}</strong>
                  <span>{check.detail}</span>
                </div>
              ))}
            </div>
          )}
          {tab === "artifacts" && (
            <div style={SB.panel}>
              <button type="button" onClick={() => void exportBundle()} disabled={!sessionId || loading} style={SB.actionBtn}>
                {loading ? "Exporting..." : "Export bundle"}
              </button>
              {ideView.artifacts.length === 0 && <span style={SB.muted}>No artifacts captured yet.</span>}
              {ideView.artifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact as WbArtifact} />)}
            </div>
          )}
          {tab === "screenshots" && (
            <div style={SB.panel}>
              <button type="button" onClick={() => void captureScreenshot()} disabled={!sessionId || loading} style={SB.actionBtn}>
                {loading ? "Capturing..." : "Capture screenshot"}
              </button>
              {ideView.screenshots.length === 0 && <span style={SB.muted}>No screenshots captured yet.</span>}
              {ideView.screenshots.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact as WbArtifact} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: SessionStatus }) {
  const color = status === "running" || status === "starting" ? "var(--pulse)"
    : status === "failed" || status === "cancelled" ? "var(--ember)"
    : status === "completed" ? "var(--pulse-deep)" : "var(--haze)";
  return <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />;
}

function ArtifactRow({ artifact }: { artifact: WbArtifact }) {
  return (
    <div style={SB.artifactRow}>
      <div style={SB.artifactTop}>
        <strong style={SB.artifactTitle}>{artifact.title}</strong>
        <span className="mono" style={SB.artifactKind}>{artifact.kind}</span>
      </div>
      <div className="mono" style={SB.artifactMeta}>
        {artifact.createdByAgent ? `${artifact.createdByAgent} · ` : ""}{artifact.path ?? artifact.previewUrl ?? artifact.storageKey}
      </div>
    </div>
  );
}

const border = "1px solid rgba(255,255,255,.08)";

const SB = {
  backdrop: {
    position: "fixed", inset: 0, zIndex: 95, background: "rgba(0,0,0,.62)", backdropFilter: "blur(8px)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 32,
  } as React.CSSProperties,
  shell: {
    width: "min(1100px, 100%)", height: "min(760px, 92vh)", display: "flex", flexDirection: "column",
    background: "var(--ink)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 16,
    boxShadow: "var(--shadow-soft)", overflow: "hidden",
  } as React.CSSProperties,
  head: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
    padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,.07)",
  } as React.CSSProperties,
  titleGroup: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 } as React.CSSProperties,
  actions: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 } as React.CSSProperties,
  kicker: { fontSize: 10, letterSpacing: ".18em", color: "var(--pulse)", whiteSpace: "nowrap" } as React.CSSProperties,
  objective: { fontSize: 13, color: "var(--mist)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  openTab: { color: "var(--bone-2)", textDecoration: "none", fontSize: 11, letterSpacing: ".1em", padding: "6px 10px", border: "1px solid rgba(255,255,255,.12)", borderRadius: 7 } as React.CSSProperties,
  close: { background: "transparent", border: 0, color: "var(--haze)", cursor: "pointer", fontSize: 20, width: 30, height: 30, borderRadius: 7 } as React.CSSProperties,
  urlbar: { padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,.06)", fontSize: 11, color: "var(--mist)", background: "var(--steel)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as React.CSSProperties,
  tabs: { display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 5, padding: "10px 12px", borderBottom: border, background: "rgba(255,255,255,.015)" } as React.CSSProperties,
  tab: (active: boolean) => ({
    height: 30, minWidth: 0, borderRadius: 7, border: active ? "1px solid rgba(110,231,183,.38)" : border,
    background: active ? "rgba(110,231,183,.09)" : "transparent", color: active ? "var(--pulse)" : "var(--mist)",
    fontSize: 11, fontWeight: 700, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  }) as React.CSSProperties,
  error: { margin: "10px 12px 0", padding: "8px 10px", borderRadius: 7, border: "1px solid rgba(251,146,60,.24)", color: "var(--ember)", background: "rgba(251,146,60,.1)", fontSize: 12 } as React.CSSProperties,
  body: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "rgba(0,0,0,.12)" } as React.CSSProperties,
  previewPane: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } as React.CSSProperties,
  frame: { flex: 1, width: "100%", border: 0, background: "#fff", minHeight: 0 } as React.CSSProperties,
  previewActions: { display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 12px", borderTop: border } as React.CSSProperties,
  actionBtn: { height: 32, padding: "0 12px", borderRadius: 8, border, background: "rgba(255,255,255,.03)", color: "var(--mist)", fontSize: 12, cursor: "pointer" } as React.CSSProperties,
  splitPane: { flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "300px 1fr", gap: 10, padding: 12 } as React.CSSProperties,
  listPane: { minHeight: 0, overflow: "auto", border, borderRadius: 8, padding: 8, background: "rgba(255,255,255,.02)" } as React.CSSProperties,
  fileBtn: (active: boolean, isDir: boolean) => ({ width: "100%", display: "block", textAlign: "left", border: 0, borderRadius: 6, background: active ? "rgba(110,231,183,.1)" : "transparent", color: isDir ? "var(--haze)" : "var(--mist)", padding: "6px 8px", fontSize: 12, cursor: isDir ? "default" : "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) as React.CSSProperties,
  panel: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 10, padding: 12 } as React.CSSProperties,
  text: { margin: 0, color: "var(--mist)", fontSize: 13, lineHeight: 1.5 } as React.CSSProperties,
  muted: { color: "var(--haze)", fontSize: 12, lineHeight: 1.5 } as React.CSSProperties,
  dim: { opacity: 0.68 } as React.CSSProperties,
  chipList: { display: "flex", flexWrap: "wrap", gap: 6 } as React.CSSProperties,
  pathChip: { border, borderRadius: 999, padding: "3px 7px", color: "var(--mist)", background: "rgba(255,255,255,.03)", fontSize: 11 } as React.CSSProperties,
  terminal: { flex: 1, minHeight: 0, overflow: "auto", padding: 14, fontSize: 12, lineHeight: 1.7, color: "var(--mist)", background: "rgba(0,0,0,.18)" } as React.CSSProperties,
  termBlock: { padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,.05)", whiteSpace: "normal", overflowWrap: "anywhere" } as React.CSSProperties,
  termLine: { padding: "2px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as React.CSSProperties,
  checkRow: (status: "pass" | "fail" | "skip") => ({ display: "grid", gridTemplateColumns: "48px minmax(90px, .45fr) 1fr", gap: 10, alignItems: "start", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.05)", color: status === "fail" ? "var(--ember)" : status === "pass" ? "var(--pulse)" : "var(--mist)", fontSize: 12, lineHeight: 1.45 }) as React.CSSProperties,
  artifactRow: { border, borderRadius: 8, padding: "8px 10px", background: "rgba(255,255,255,.02)", display: "flex", flexDirection: "column", gap: 5 } as React.CSSProperties,
  artifactTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } as React.CSSProperties,
  artifactTitle: { fontSize: 12, color: "var(--bone)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  artifactKind: { color: "var(--pulse)", fontSize: 10, textTransform: "uppercase" } as React.CSSProperties,
  artifactMeta: { color: "var(--haze)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
};
