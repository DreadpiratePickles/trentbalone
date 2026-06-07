"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentActivityFeed, CodeBlock, inferCodeBlock, mapWorkbenchEventsToSteps, type ActivityStep } from "@/components/agent-activity";
import { Spinner } from "@/components/ui";
import { buildWorkbenchIdeView } from "@/lib/workbench-ide-view";
import { workbenchPreviewFrameSrc } from "@/lib/workbench-preview-url";
import { readApiError } from "@/lib/read-api-error";

type SessionStatus = "queued" | "starting" | "running" | "paused" | "completed" | "failed" | "cancelled";

type Session = {
  id: string;
  status?: SessionStatus;
  previewUrl?: string;
};

type TestRunResult = {
  passed: number;
  failed: number;
  skipped?: number;
  durationMs?: number;
  output?: string;
  exitCode?: number;
};

type ExecRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
  blocked?: boolean;
  blockedReason?: string;
};

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
type RailTab = "preview" | "files" | "diff" | "terminal" | "tests" | "artifacts" | "screenshots";

const RAIL_TABS: { key: RailTab; label: string; title: string }[] = [
  { key: "preview", label: "Preview", title: "Live sandbox preview" },
  { key: "files", label: "Files", title: "Generated file tree and file viewer" },
  { key: "diff", label: "Diff", title: "Changes since the persisted checkpoint" },
  { key: "terminal", label: "Terminal", title: "Shell commands, outputs, and exits" },
  { key: "tests", label: "Tests", title: "Verification checks and failures" },
  { key: "artifacts", label: "Artifacts", title: "Captured files, logs, previews, and exports" },
  { key: "screenshots", label: "Shots", title: "Captured screenshots" },
];

export function WorkbenchEvidenceRail({
  active,
  events,
  artifacts,
  activity,
  streaming,
  onRefreshSession,
  onOpenSandbox,
}: {
  active: Session | null;
  events: WbEvent[];
  artifacts: WbArtifact[];
  activity: ActivityStep[];
  streaming: boolean;
  onRefreshSession: () => Promise<void>;
  onOpenSandbox: () => void;
}) {
  const [railTab, setRailTab] = useState<RailTab>("preview");
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [diff, setDiff] = useState<DiffSummary | null>(null);
  const [railLoading, setRailLoading] = useState(false);
  const [railError, setRailError] = useState<string | null>(null);
  const [execCommand, setExecCommand] = useState("");
  const [execRunning, setExecRunning] = useState(false);
  const [execResult, setExecResult] = useState<ExecRunResult | null>(null);
  const [testsRunning, setTestsRunning] = useState(false);
  const [testsResult, setTestsResult] = useState<TestRunResult | null>(null);
  const [testCommand, setTestCommand] = useState("");

  const sessionRunning = active?.status === "running";

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

  const captureScreenshot = useCallback(async () => {
    if (!active?.previewUrl) return;
    setRailLoading(true);
    setRailError(null);
    try {
      const res = await fetch(`/api/workbench/${active.id}/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: active.previewUrl, width: 1280, height: 720 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Screenshot failed");
      }
      setRailTab("screenshots");
      await onRefreshSession();
    } catch (err) {
      setRailError(err instanceof Error ? err.message : "Screenshot failed");
    } finally {
      setRailLoading(false);
    }
  }, [active, onRefreshSession]);

  const runExec = useCallback(async () => {
    if (!active?.id || !execCommand.trim()) return;
    setExecRunning(true);
    setRailError(null);
    try {
      const res = await fetch(`/api/workbench/${active.id}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: execCommand.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? await readApiError(res));
      }
      const body = await res.json() as { result: ExecRunResult };
      setExecResult(body.result);
      setExecCommand("");
      await onRefreshSession();
    } catch (err) {
      setRailError(err instanceof Error ? err.message : "Command failed");
    } finally {
      setExecRunning(false);
    }
  }, [active, execCommand, onRefreshSession]);

  const runTests = useCallback(async () => {
    if (!active?.id) return;
    setTestsRunning(true);
    setRailError(null);
    try {
      const res = await fetch(`/api/workbench/${active.id}/tests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testCommand.trim() ? { command: testCommand.trim() } : {}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? await readApiError(res));
      }
      const body = await res.json() as { result: TestRunResult };
      setTestsResult(body.result);
      await onRefreshSession();
    } catch (err) {
      setRailError(err instanceof Error ? err.message : "Tests failed");
    } finally {
      setTestsRunning(false);
    }
  }, [active, onRefreshSession, testCommand]);

  const exportBundle = useCallback(async () => {
    if (!active) return;
    setRailLoading(true);
    setRailError(null);
    try {
      const res = await fetch(`/api/workbench/${active.id}/export`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Export failed");
      }
      setRailTab("artifacts");
      await onRefreshSession();
    } catch (err) {
      setRailError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setRailLoading(false);
    }
  }, [active, onRefreshSession]);

  useEffect(() => {
    if (!active?.id || railTab !== "files") return;
    let cancelled = false;
    setRailLoading(true);
    setRailError(null);
    fetch(`/api/workbench/${active.id}/files`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? "Failed to load files");
        return res.json() as Promise<{ files: FileEntry[] }>;
      })
      .then((body) => { if (!cancelled) setFileEntries(body.files ?? []); })
      .catch((err) => { if (!cancelled) setRailError(err instanceof Error ? err.message : "Failed to load files"); })
      .finally(() => { if (!cancelled) setRailLoading(false); });
    return () => { cancelled = true; };
  }, [active?.id, railTab, events.length, artifacts.length]);

  useEffect(() => {
    if (!active?.id || railTab !== "diff") return;
    let cancelled = false;
    setRailLoading(true);
    setRailError(null);
    fetch(`/api/workbench/${active.id}/diff`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? "Failed to load diff");
        return res.json() as Promise<{ diff: DiffSummary }>;
      })
      .then((body) => { if (!cancelled) setDiff(body.diff ?? null); })
      .catch((err) => { if (!cancelled) setRailError(err instanceof Error ? err.message : "Failed to load diff"); })
      .finally(() => { if (!cancelled) setRailLoading(false); });
    return () => { cancelled = true; };
  }, [active?.id, railTab, events.length, artifacts.length]);

  useEffect(() => {
    if (!active?.id || !selectedFile || railTab !== "files") return;
    let cancelled = false;
    setRailLoading(true);
    setRailError(null);
    fetch(`/api/workbench/${active.id}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "read", path: selectedFile }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? "Failed to read file");
        return res.json() as Promise<{ content: string }>;
      })
      .then((body) => { if (!cancelled) setFileContent(body.content ?? ""); })
      .catch((err) => { if (!cancelled) setRailError(err instanceof Error ? err.message : "Failed to read file"); })
      .finally(() => { if (!cancelled) setRailLoading(false); });
    return () => { cancelled = true; };
  }, [active?.id, selectedFile, railTab]);

  return (
    <aside style={R.rail}>
      <div style={R.railTabs}>
        {RAIL_TABS.map((tab) => (
          <button key={tab.key} onClick={() => setRailTab(tab.key)} style={R.railTab(railTab === tab.key)} title={tab.title}>
            {tab.label}
          </button>
        ))}
      </div>
      {railError && <div style={R.railError}>{railError}</div>}

      {railTab === "preview" && (
        <div style={R.railSection}>
          <div style={R.sectionHead}>
            <span className="mono" style={R.kicker}>SANDBOX</span>
            {active?.previewUrl && (
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => void captureScreenshot()} className="mono" style={R.expandBtn} title="Capture screenshot">
                  {railLoading ? "..." : "capture"}
                </button>
                <button onClick={onOpenSandbox} className="mono" style={R.expandBtn} title="Open testable sandbox">test</button>
              </div>
            )}
          </div>
          {active?.previewUrl ? (
            <iframe src={workbenchPreviewFrameSrc(active)} style={R.previewFrame} title="sandbox preview" sandbox="allow-scripts allow-same-origin" />
          ) : (
            <div style={R.previewEmpty} className="mono">{streaming ? "building..." : "no sandbox yet"}</div>
          )}
        </div>
      )}

      {railTab === "files" && (
        <RailPanel title="FILES" loading={railLoading && !selectedFile}>
          <div style={R.splitRail}>
            <div style={R.fileList}>
              {fileEntries.length === 0 && <span style={R.railMuted}>No files visible yet.</span>}
              {fileEntries.map((file) => (
                <button key={file.path} onClick={() => !file.isDir && setSelectedFile(file.path)} disabled={file.isDir} style={R.fileBtn(selectedFile === file.path, file.isDir)} title={file.path}>
                  {file.isDir ? ">" : "-"} {file.path}
                </button>
              ))}
            </div>
            {selectedFileBlock ? (
              <CodeBlock block={selectedFileBlock} defaultCollapsed={false} />
            ) : (
              <div style={R.railMuted}>{selectedFile ? "loading file..." : "Select a file to inspect it."}</div>
            )}
          </div>
        </RailPanel>
      )}

      {railTab === "diff" && (
        <RailPanel title="DIFF" loading={railLoading}>
          <p style={R.railText}>{diff?.summary ?? "No diff loaded yet."}</p>
          <div style={R.chipList}>{(diff?.changedPaths ?? []).map((path) => <span key={path} style={R.pathChip}>{path}</span>)}</div>
          {diff?.patch ? <CodeBlock block={{ content: diff.patch, language: "diff", mode: "diff", filename: "changes.patch" }} /> : null}
        </RailPanel>
      )}

      {railTab === "terminal" && (
        <RailPanel title="TERMINAL" loading={false}>
          <form
            onSubmit={(e) => { e.preventDefault(); void runExec(); }}
            style={{ display: "flex", gap: 8, marginBottom: 8 }}
          >
            <input
              className="input mono"
              value={execCommand}
              onChange={(e) => setExecCommand(e.target.value)}
              placeholder={sessionRunning ? "run command…" : "session not running"}
              disabled={!sessionRunning || execRunning}
              style={{ flex: 1, fontSize: 11 }}
            />
            <button
              type="submit"
              className="btn btn-secondary btn-mono"
              disabled={!sessionRunning || execRunning || !execCommand.trim()}
              style={{ fontSize: 10 }}
            >
              {execRunning ? "…" : "run"}
            </button>
          </form>
          {execResult && (
            <CodeBlock
              block={{
                content: [
                  execResult.blocked ? `blocked: ${execResult.blockedReason ?? "denied"}` : "",
                  execResult.stdout,
                  execResult.stderr,
                  `exit ${execResult.exitCode}`,
                ].filter(Boolean).join("\n"),
                language: "shell",
                mode: "code",
                filename: "exec",
              }}
              defaultCollapsed={false}
            />
          )}
          {terminalSteps.length === 0 ? <span style={R.railMuted}>idle</span> : (
            <AgentActivityFeed steps={terminalSteps} live={streaming} aria-label="Workbench terminal activity" />
          )}
        </RailPanel>
      )}

      {railTab === "tests" && (
        <RailPanel title="TESTS · VERIFICATION" loading={testsRunning}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input
              className="input mono"
              value={testCommand}
              onChange={(e) => setTestCommand(e.target.value)}
              placeholder="optional test command"
              disabled={!sessionRunning || testsRunning}
              style={{ flex: 1, minWidth: 120, fontSize: 11 }}
            />
            <button
              type="button"
              onClick={() => void runTests()}
              className="btn btn-secondary btn-mono"
              disabled={!sessionRunning || testsRunning}
              style={{ fontSize: 10 }}
            >
              {testsRunning ? "running…" : "run tests"}
            </button>
          </div>
          {!sessionRunning && (
            <span style={R.railMuted}>Start or resume a running session to execute tests.</span>
          )}
          {testsResult && (
            <div style={{ marginBottom: 8 }}>
              <p style={R.railText}>
                {testsResult.passed} passed · {testsResult.failed} failed
                {typeof testsResult.skipped === "number" ? ` · ${testsResult.skipped} skipped` : ""}
                {typeof testsResult.exitCode === "number" ? ` · exit ${testsResult.exitCode}` : ""}
              </p>
              {testsResult.output ? (
                <CodeBlock block={{ content: testsResult.output, language: "shell", mode: "code", filename: "tests" }} />
              ) : null}
            </div>
          )}
          {ideView.verifyChecks.length === 0 && !testsResult && <span style={R.railMuted}>No verification checks recorded yet.</span>}
          {ideView.verifyChecks.map((check) => (
            <div key={`${check.name}-${check.detail}`} style={R.checkRow(check.status)}>
              <span className="mono">{check.status}</span>
              <strong>{check.name}</strong>
              <span>{check.detail}</span>
            </div>
          ))}
        </RailPanel>
      )}

      {railTab === "artifacts" && (
        <RailPanel title="ARTIFACTS" loading={false}>
          <button onClick={() => void exportBundle()} disabled={!active || railLoading} style={R.ghostBtn}>{railLoading ? "Exporting..." : "Export bundle"}</button>
          {ideView.artifacts.length === 0 && <span style={R.railMuted}>No artifacts captured yet.</span>}
          {ideView.artifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact as WbArtifact} />)}
        </RailPanel>
      )}

      {railTab === "screenshots" && (
        <RailPanel title="SCREENSHOTS" loading={railLoading}>
          <button onClick={() => void captureScreenshot()} disabled={!active?.previewUrl || railLoading} style={R.ghostBtn}>
            {railLoading ? "Capturing..." : "Capture screenshot"}
          </button>
          {ideView.screenshots.length === 0 && <span style={R.railMuted}>No screenshots captured yet.</span>}
          {ideView.screenshots.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact as WbArtifact} />)}
        </RailPanel>
      )}
    </aside>
  );
}

function RailPanel({ title, loading, children }: { title: string; loading: boolean; children: React.ReactNode }) {
  return (
    <div style={{ ...R.railSection, flex: 1, minHeight: 0 }}>
      <div style={R.sectionHead}>
        <span className="mono" style={R.kicker}>{title}</span>
        {loading && <Spinner />}
      </div>
      {children}
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: WbArtifact }) {
  return (
    <div style={R.artifactRow}>
      <div style={R.artifactTop}>
        <strong style={R.artifactTitle}>{artifact.title}</strong>
        <span className="mono" style={R.artifactKind}>{artifact.kind}</span>
      </div>
      <div className="mono" style={R.artifactMeta}>
        {artifact.createdByAgent ? `${artifact.createdByAgent} · ` : ""}{artifact.path ?? artifact.previewUrl ?? artifact.storageKey}
      </div>
    </div>
  );
}

const border = "1px solid rgba(255,255,255,.07)";
const surface = "rgba(255,255,255,.02)";

const R = {
  rail: { borderLeft: border, display: "flex", flexDirection: "column", minHeight: 0 } as React.CSSProperties,
  railTabs: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 4, padding: "10px 12px", borderBottom: border, background: "rgba(255,255,255,.015)" } as React.CSSProperties,
  railTab: (active: boolean) => ({
    minWidth: 0, height: 28, padding: "0 6px", borderRadius: 7, border: active ? "1px solid rgba(110,231,183,.32)" : border,
    background: active ? "rgba(110,231,183,.08)" : "transparent", color: active ? "var(--pulse)" : "var(--mist)",
    fontSize: 10, fontWeight: 700, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  }) as React.CSSProperties,
  railError: { margin: "10px 12px 0", padding: "8px 10px", borderRadius: 7, background: "rgba(251,146,60,.1)", border: "1px solid rgba(251,146,60,.24)", color: "var(--ember)", fontSize: 12 } as React.CSSProperties,
  railSection: { padding: "14px 16px", borderBottom: border, display: "flex", flexDirection: "column", gap: 10, minHeight: 0 } as React.CSSProperties,
  sectionHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } as React.CSSProperties,
  kicker: { fontSize: 10, letterSpacing: ".18em", color: "var(--haze)" } as React.CSSProperties,
  previewFrame: { width: "100%", height: 200, border, borderRadius: 8, background: "#fff" } as React.CSSProperties,
  previewEmpty: { height: 200, display: "grid", placeItems: "center", border, borderRadius: 8, color: "var(--haze)", fontSize: 12, background: surface } as React.CSSProperties,
  expandBtn: { background: "transparent", border: 0, color: "var(--pulse)", cursor: "pointer", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", padding: "2px 4px" } as React.CSSProperties,
  splitRail: { display: "grid", gridTemplateRows: "minmax(120px, 34%) 1fr", gap: 10, minHeight: 0, flex: 1 } as React.CSSProperties,
  fileList: { overflowY: "auto", border, borderRadius: 8, padding: 6, minHeight: 0, background: surface } as React.CSSProperties,
  fileBtn: (active: boolean, isDir: boolean) => ({ width: "100%", display: "block", textAlign: "left", border: 0, borderRadius: 6, background: active ? "rgba(110,231,183,.1)" : "transparent", color: isDir ? "var(--haze)" : "var(--mist)", padding: "5px 7px", fontSize: 11, cursor: isDir ? "default" : "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) as React.CSSProperties,
  railText: { margin: 0, color: "var(--mist)", fontSize: 12, lineHeight: 1.5 } as React.CSSProperties,
  railMuted: { color: "var(--haze)", fontSize: 12, lineHeight: 1.5 } as React.CSSProperties,
  chipList: { display: "flex", flexWrap: "wrap", gap: 6, overflowY: "auto" } as React.CSSProperties,
  pathChip: { border, borderRadius: 999, padding: "3px 7px", color: "var(--mist)", background: "rgba(255,255,255,.03)", fontSize: 10 } as React.CSSProperties,
  terminal: { flex: 1, overflowY: "auto", fontSize: 11.5, lineHeight: 1.7, color: "var(--mist)", minHeight: 0 } as React.CSSProperties,
  termLine: { padding: "1px 0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as React.CSSProperties,
  termBlock: { padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,.05)", whiteSpace: "normal", overflowWrap: "anywhere" } as React.CSSProperties,
  checkRow: (status: "pass" | "fail" | "skip") => ({ display: "grid", gridTemplateColumns: "42px minmax(70px, .5fr) 1fr", gap: 8, alignItems: "start", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.05)", color: status === "fail" ? "var(--ember)" : status === "pass" ? "var(--pulse)" : "var(--mist)", fontSize: 12, lineHeight: 1.45 }) as React.CSSProperties,
  ghostBtn: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, height: 32, padding: "0 12px", borderRadius: 8, border, background: "rgba(255,255,255,.03)", color: "var(--mist)", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" } as React.CSSProperties,
  artifactRow: { border, borderRadius: 8, padding: "8px 10px", background: surface, display: "flex", flexDirection: "column", gap: 5 } as React.CSSProperties,
  artifactTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } as React.CSSProperties,
  artifactTitle: { fontSize: 12, color: "var(--bone)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  artifactKind: { color: "var(--pulse)", fontSize: 10, textTransform: "uppercase" } as React.CSSProperties,
  artifactMeta: { color: "var(--haze)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
};
