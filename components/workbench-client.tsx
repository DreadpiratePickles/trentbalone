"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { I, Pill, Spinner, AgentChip } from "@/components/ui";
import { WorkbenchEvidenceRail } from "@/components/workbench-evidence-rail";
import { WorkbenchSandboxModal } from "@/components/workbench-sandbox-modal";
import { AgentActivityFeed, mapWorkbenchChunk, type ActivityStep } from "@/components/agent-activity";
import { WorkbenchBubble, WorkbenchNewSession, WorkbenchStatusDot, type WorkbenchCreateSource } from "@/components/workbench-session-parts";
import { buildWorkbenchCreateRequestBody } from "@/lib/workbench-session-request";
import { getWorkbenchAgents, type WorkbenchAgent } from "@/lib/workbench-agents";
import {
  buildWorkbenchAgentCreateRequest,
  filterWorkbenchSessionsForSurface,
  surfaceModeFromQuery,
  type WorkbenchSurfaceMode,
} from "@/lib/workbench-client-surface";
import { workbenchPreviewFrameSrc } from "@/lib/workbench-preview-url";
import { findPendingWorkbenchPlanApproval, latestWorkbenchUserPrompt, type WorkbenchApprovalSummary } from "@/lib/workbench-approval-ui";
import { readApiError } from "@/lib/read-api-error";
import { ErrorBanner, LlmNotConfiguredBanner } from "@/components/error-banner";
import { useRuntimeHealth } from "@/components/runtime-health";
import { useStatusToast } from "@/components/status-toast";
import type { AgentRole, CompanyAutonomyMode, CompanyAutonomySettings, WorkbenchSessionMetadata } from "@/lib/types";
import { McpToolVisibilityPanel } from "@/components/mcp-tool-visibility-panel";

// ── Types (mirror lib/types-workbench + lib/workbench-agent chunk protocol) ──────

type AgentMode = "build" | "research" | "design";
type SessionStatus = "queued" | "starting" | "running" | "paused" | "completed" | "failed" | "cancelled";

type Session = {
  id: string;
  companyId: string;
  agentRole?: AgentRole;
  agentMode: AgentMode;
  status: SessionStatus;
  objective: string;
  previewUrl?: string;
  messageCount?: number;
  costCents: number;
  updatedAt: string;
  metadata?: {
    rollbackMode?: WorkbenchSessionMetadata["rollbackMode"];
    rollbackDescription?: string;
    agentRun?: WorkbenchSessionMetadata["agentRun"];
    appSolo?: WorkbenchSessionMetadata["appSolo"];
  } & Record<string, unknown>;
};

type ChatMessage = { id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string };
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
type Stats = { total: number; byMode: Record<AgentMode, number> };

type AgentChunk =
  | { type: "status"; phase: string; detail?: string }
  | { type: "content"; content: string }
  | { type: "plan"; steps: { kind: string; summary?: string; path?: string; command?: string }[] }
  | { type: "file"; path: string; action: string; bytes: number }
  | { type: "command"; command: string; exitCode: number; output: string }
  | { type: "test"; passed: number; failed: number; healed: boolean }
  | { type: "verify"; passed: boolean; checks: { name: string; status: string; detail: string }[] }
  | { type: "preview"; url: string }
  | { type: "error"; message: string }
  | { type: "done"; messageId: string };


const MODES: { key: AgentMode; label: string; code: string; blurb: string }[] = [
  { key: "build", label: "Build", code: "BLD", blurb: "Autonomous plan → write → run → heal → preview" },
  { key: "research", label: "Research", code: "RSR", blurb: "Deep research synthesis with sources" },
  { key: "design", label: "Design", code: "DSN", blurb: "Design system + UI/UX spec" },
];

const MODE_TONE: Record<AgentMode, "pulse" | "ember" | "mist"> = { build: "pulse", research: "mist", design: "ember" };

// ── Component ─────────────────────────────────────────────────────────────────

export function WorkbenchClient({ companyId, agents: initialAgents }: { companyId: string; agents?: WorkbenchAgent[] }) {
  const searchParams = useSearchParams();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<WbEvent[]>([]);
  const [artifacts, setArtifacts] = useState<WbArtifact[]>([]);
  const [activity, setActivity] = useState<ActivityStep[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [composer, setComposer] = useState("");
  const [modeFilter, setModeFilter] = useState<AgentMode>("build");
  const [creating, setCreating] = useState(false);
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [composerError, setComposerError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState("");
  const [approvals, setApprovals] = useState<WorkbenchApprovalSummary[]>([]);
  const [approvalActionId, setApprovalActionId] = useState<string | null>(null);
  const [autonomyMode, setAutonomyMode] = useState<CompanyAutonomyMode>("supervised");
  const [autonomySaving, setAutonomySaving] = useState(false);
  const [autonomyNotice, setAutonomyNotice] = useState("");
  const [surfaceMode, setSurfaceMode] = useState<WorkbenchSurfaceMode>(() => surfaceModeFromQuery(searchParams.get("mode")));
  const agents = useMemo(() => initialAgents?.length ? initialAgents : getWorkbenchAgents(), [initialAgents]);
  const [selectedAgentRole, setSelectedAgentRole] = useState<WorkbenchAgent["role"]>("engineer");
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.role === selectedAgentRole) ?? agents[0],
    [agents, selectedAgentRole],
  );

  const { readiness, loading: healthLoading } = useRuntimeHealth();
  const { pushError } = useStatusToast();
  // Don't show "not configured" while the health check is still in flight
  const llmConfigured = healthLoading ? true : (readiness?.llm ?? false);

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);
  const pendingPlanApproval = useMemo(
    () => findPendingWorkbenchPlanApproval(active?.id, approvals),
    [active?.id, approvals],
  );
  const transcriptRef = useRef<HTMLDivElement>(null);
  const autoOpenedRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSurfaceMode(surfaceModeFromQuery(searchParams.get("mode")));
  }, [searchParams]);

  const refreshSessions = useCallback(async () => {
    const [sRes, stRes] = await Promise.all([
      fetch(`/api/workbench?companyId=${companyId}`),
      fetch(`/api/workbench/stats?companyId=${companyId}`),
    ]);
    if (sRes.ok) {
      setSessions((await sRes.json()).sessions ?? []);
    } else {
      const message = await readApiError(sRes);
      setSessionError(message);
      pushError(message);
    }
    if (stRes.ok) setStats((await stRes.json()).stats ?? null);
  }, [companyId, pushError]);

  const refreshApprovals = useCallback(async () => {
    const res = await fetch(`/api/approvals?companyId=${companyId}`);
    if (!res.ok) return;
    const data = await res.json() as { approvals?: WorkbenchApprovalSummary[] };
    setApprovals(data.approvals ?? []);
  }, [companyId]);

  const refreshAutonomy = useCallback(async () => {
    const res = await fetch(`/api/companies/${companyId}/autonomy`);
    if (!res.ok) return;
    const data = await res.json() as { autonomy?: CompanyAutonomySettings };
    if (data.autonomy?.mode) setAutonomyMode(data.autonomy.mode);
  }, [companyId]);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);
  useEffect(() => { void refreshApprovals(); }, [refreshApprovals]);
  useEffect(() => { void refreshAutonomy(); }, [refreshAutonomy]);

  const loadSession = useCallback(async (id: string) => {
    setActiveId(id);
    setActivity([]);
    setStreamText("");
    const [mRes, dRes] = await Promise.all([
      fetch(`/api/workbench/${id}/messages`),
      fetch(`/api/workbench/${id}`),
    ]);
    if (mRes.ok) {
      setMessages((await mRes.json()).messages ?? []);
    } else {
      const message = await readApiError(mRes);
      setSessionError(message);
      pushError(message);
    }
    if (dRes.ok) {
      const details = await dRes.json();
      setEvents(details.events ?? []);
      setArtifacts(details.artifacts ?? []);
    } else {
      const message = await readApiError(dRes);
      setSessionError(message);
      pushError(message);
    }
  }, [pushError]);

  useEffect(() => {
    if (!activeId && sessions.length > 0) void loadSession(sessions[0].id);
  }, [sessions, activeId, loadSession]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamText]);

  // Surface the sandbox the moment a build finishes, so the founder can test it.
  useEffect(() => {
    if (active && active.status === "completed" && active.previewUrl && autoOpenedRef.current !== active.id) {
      autoOpenedRef.current = active.id;
      setSandboxOpen(true);
    }
  }, [active]);

  const createSession = useCallback(async (
    objective: string,
    mode: AgentMode,
    agent?: WorkbenchAgent,
    source?: WorkbenchCreateSource,
  ): Promise<boolean> => {
    if (!llmConfigured) {
      setSessionError("LLM not configured — see docs/RUN.md");
      return false;
    }
    setCreating(true);
    setSessionError("");
    try {
      const importFiles = source?.files?.filter(Boolean) ?? [];
      const repoUrl = source?.repoUrl?.trim();
      const needsImport = importFiles.length > 0 || !!repoUrl;
      const body = agent
        ? buildWorkbenchAgentCreateRequest({ companyId, objective, agent })
        : buildWorkbenchCreateRequestBody({ companyId, objective, agentMode: mode });
      if (repoUrl) body.repoUrl = repoUrl;
      if (needsImport) body.enqueue = false;

      const res = await fetch(`/api/workbench`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const message = await readApiError(res);
        setSessionError(message);
        pushError(message);
        return false;
      }
      const { session } = await res.json();
      if (needsImport) {
        if (importFiles.length) {
          const upload = await postWorkbenchUpload(session.id, importFiles);
          if (!upload.ok) {
            const message = upload.message;
            setSessionError(message);
            pushError(message);
            await refreshSessions();
            await loadSession(session.id);
            return false;
          }
          setUploadNotice(upload.message);
        }
        const started = await fetch(`/api/workbench/${session.id}/start`, { method: "POST" });
        if (!started.ok) {
          const message = await readApiError(started);
          setSessionError(message);
          pushError(message);
          await refreshSessions();
          await loadSession(session.id);
          return false;
        }
      }
      await refreshSessions();
      await loadSession(session.id);
      return true;
    } finally {
      setCreating(false);
    }
  }, [companyId, refreshSessions, loadSession, llmConfigured, pushError]);

  const appendActivityStep = useCallback((chunk: AgentChunk) => {
    setActivity((prev) => {
      const step = mapWorkbenchChunk(chunk, prev.length);
      return step ? [...prev, step] : prev;
    });
  }, []);

  const sendContent = useCallback(async (rawContent: string) => {
    const content = rawContent.trim();
    if (!content || !active || streaming) return;
    if (!llmConfigured) {
      setComposerError("LLM not configured — see docs/RUN.md");
      return;
    }
    setComposer("");
    setComposerError("");
    setStreaming(true);
    setStreamText("");
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: "user", content, createdAt: new Date().toISOString() }]);

    try {
      const res = await fetch(`/api/workbench/${active.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const message = await readApiError(res);
        setComposerError(message);
        pushError(message);
        appendActivityStep({ type: "error", message });
        return;
      }
      if (!res.body) {
        const message = "No response stream from agent";
        setComposerError(message);
        pushError(message);
        appendActivityStep({ type: "error", message });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          let chunk: AgentChunk;
          try { chunk = JSON.parse(payload) as AgentChunk; } catch { continue; }
          if (chunk.type === "content") { acc += chunk.content; setStreamText(acc); }
          else appendActivityStep(chunk);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "stream failed";
      setComposerError(message);
      pushError(message);
      appendActivityStep({ type: "error", message });
    } finally {
      setStreaming(false);
      setStreamText("");
      if (active) await loadSession(active.id);
      await refreshSessions();
    }
  }, [active, streaming, appendActivityStep, loadSession, refreshSessions, llmConfigured, pushError]);

  const sendMessage = useCallback(async () => {
    await sendContent(composer);
  }, [composer, sendContent]);

  const deleteSession = useCallback(async (id: string) => {
    if (streaming || deletingId) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/workbench/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const message = await readApiError(res);
        setSessionError(message);
        pushError(message);
        return;
      }
      setSessions((prev) => prev.filter((session) => session.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
        setEvents([]);
        setArtifacts([]);
        setActivity([]);
      }
    } finally {
      setDeletingId(null);
    }
  }, [activeId, deletingId, streaming, pushError]);

  const refreshActive = useCallback(async () => {
    await refreshSessions();
    await refreshApprovals();
    if (activeId) await loadSession(activeId);
  }, [activeId, loadSession, refreshApprovals, refreshSessions]);

  const setWorkbenchAutonomy = useCallback(async (mode: CompanyAutonomyMode) => {
    setAutonomySaving(true);
    setAutonomyNotice("");
    try {
      const res = await fetch(`/api/companies/${companyId}/autonomy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const message = await readApiError(res);
        setAutonomyNotice(message);
        pushError(message);
        return;
      }
      const data = await res.json() as { autonomy?: CompanyAutonomySettings };
      setAutonomyMode(data.autonomy?.mode ?? mode);
      setAutonomyNotice(mode === "autonomous"
        ? "Autonomous test mode is on. Workbench plans can write/run without the first approval pause."
        : "Supervised mode restored. New Workbench plans pause for approval before writes.");
      if (mode === "autonomous" && active?.status === "paused" && pendingPlanApproval && !streaming) {
        setAutonomyNotice("Autonomous test mode is on. Continuing the paused Workbench run now.");
        await sendContent(latestWorkbenchUserPrompt(messages, active.objective));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Autonomy update failed";
      setAutonomyNotice(message);
      pushError(message);
    } finally {
      setAutonomySaving(false);
    }
  }, [active, companyId, messages, pendingPlanApproval, pushError, sendContent, streaming]);

  const resolveWorkbenchApproval = useCallback(async (
    approval: WorkbenchApprovalSummary,
    status: "approved" | "rejected",
  ) => {
    setApprovalActionId(approval.id);
    setComposerError("");
    try {
      const res = await fetch(`/api/approvals/${approval.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const message = await readApiError(res);
        setComposerError(message);
        pushError(message);
        return;
      }
      if (status === "approved" && active && !streaming) {
        setUploadNotice("Workbench plan approved. Continuing the run now.");
        await sendContent(latestWorkbenchUserPrompt(messages, active.objective));
      } else {
        setUploadNotice(status === "approved" ? "Workbench plan approved." : "Workbench plan rejected.");
        await refreshActive();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Approval update failed";
      setComposerError(message);
      pushError(message);
    } finally {
      setApprovalActionId(null);
    }
  }, [active, messages, pushError, refreshActive, sendContent, streaming]);

  const stopRun = useCallback(async () => {
    if (!active || streaming) return;
    const res = await fetch(`/api/workbench/${active.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    if (!res.ok) {
      const message = await readApiError(res);
      setComposerError(message);
      pushError(message);
      return;
    }
    await refreshActive();
  }, [active, refreshActive, streaming, pushError]);

  const rerunFailed = useCallback(async () => {
    if (!active || streaming) return;
    await sendContent(`Rerun the failed attempt for: ${active.objective}. Use the exact failed checks and terminal errors as repair input.`);
  }, [active, sendContent, streaming]);

  // RC1 (Fix Plan Slice 4): + upload — files, folders, and zips land in the
  // session workspace so agents can actually read them. Always ends in a
  // visible state: success summary, per-file skips, or an error banner.
  const uploadFiles = useCallback(async (fileList: FileList | null) => {
    if (!active || !fileList || fileList.length === 0 || uploading) return;
    setUploading(true);
    setUploadNotice("");
    setComposerError("");
    try {
      const result = await postWorkbenchUpload(active.id, Array.from(fileList));
      if (!result.ok) {
        const message = result.message;
        setComposerError(message);
        pushError(message);
        return;
      }
      setUploadNotice(result.message);
      await refreshActive();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed.";
      setComposerError(message);
      pushError(message);
    } finally {
      setUploading(false);
    }
  }, [active, uploading, pushError, refreshActive]);

  const filteredSessions = filterWorkbenchSessionsForSurface(sessions, surfaceMode, modeFilter);
  const newSessionMode = surfaceMode === "agents" ? selectedAgent.mode : modeFilter;
  const newSessionPlaceholder = surfaceMode === "agents"
    ? `Brief ${selectedAgent.label} for a scoped Workbench run...`
    : undefined;

  return (
    <div style={S.root}>
      {/* Left: sessions */}
      <aside style={S.sidebar}>
        <div style={S.sidebarHead}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span className="mono" style={S.kicker}>WORKBENCH</span>
            <button onClick={() => void refreshActive()} style={S.iconBtn} title="Refresh objectives and current session" aria-label="Refresh Workbench">
              <I.refresh />
            </button>
          </div>
          <div style={S.surfaceTabs} aria-label="Workbench surface">
            {(["workbench", "agents"] as const).map((surface) => (
              <button
                key={surface}
                onClick={() => setSurfaceMode(surface)}
                style={S.surfaceTab(surfaceMode === surface)}
                title={surface === "agents" ? "Run scoped agent seats inside Workbench" : "Run standard Workbench build, research, and design sessions"}
              >
                {surface === "agents" ? "Agents" : "Workbench"}
              </button>
            ))}
          </div>
          {surfaceMode === "workbench" ? (
            <div style={S.modeTabs}>
              {MODES.map((m) => (
                <button key={m.key} onClick={() => setModeFilter(m.key)} style={S.modeTab(modeFilter === m.key, MODE_TONE[m.key])} title={m.blurb}>
                  {m.label}
                </button>
              ))}
            </div>
          ) : (
            <div style={S.agentList} aria-label="Workbench agents">
              {agents.map((agent) => (
                <button
                  key={agent.role}
                  onClick={() => setSelectedAgentRole(agent.role)}
                  style={S.agentButton(selectedAgentRole === agent.role)}
                  title={agent.mission}
                >
                  <span>{agent.label}</span>
                  <span className="mono">{agent.mode}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <WorkbenchNewSession
          mode={newSessionMode}
          creating={creating}
          llmConfigured={llmConfigured}
          placeholder={newSessionPlaceholder}
          onCreate={(objective, mode, source) => createSession(objective, mode, surfaceMode === "agents" ? selectedAgent : undefined, source)}
        />

        <McpToolVisibilityPanel companyId={companyId} compact />

        {sessionError ? (
          <div style={{ padding: "8px 14px 0" }}>
            <ErrorBanner message={sessionError} onDismiss={() => setSessionError("")} />
          </div>
        ) : null}

        <div style={S.sessionList}>
          {filteredSessions.length === 0 && (
            <p style={S.empty}>
              {surfaceMode === "agents"
                ? `No ${selectedAgent.label} agent sessions yet. Describe an objective above to start one.`
                : `No ${modeFilter} sessions yet. Describe an objective above to start one.`}
            </p>
          )}
          {filteredSessions.map((s) => (
            <div key={s.id} style={S.sessionWrap(s.id === activeId)}>
              <button onClick={() => void loadSession(s.id)} style={S.sessionRow}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AgentChip code={sessionChipCode(s)} size={24} tone={MODE_TONE[s.agentMode]} />
                <span style={S.sessionTitle}>{s.objective}</span>
              </div>
              <div style={S.sessionMeta}>
                <WorkbenchStatusDot status={s.status} />
                <span className="mono">{s.status}</span>
                <span className="mono" style={{ opacity: 0.5 }}>· {s.messageCount ?? 0} msg · {s.costCents}¢</span>
              </div>
              </button>
              <button
                onClick={(event) => { event.stopPropagation(); void deleteSession(s.id); }}
                disabled={deletingId === s.id}
                style={S.deleteBtn}
                title="Delete objective"
                aria-label={`Delete ${s.objective}`}
              >
                {deletingId === s.id ? "…" : "×"}
              </button>
            </div>
          ))}
        </div>

        {stats && (
          <div style={S.statsBar} className="mono">
            <span>{stats.total} total</span>
            <span style={{ color: "var(--pulse)" }}>{stats.byMode.build} build</span>
            <span style={{ color: "var(--mist)" }}>{stats.byMode.research} rsr</span>
            <span style={{ color: "var(--ember)" }}>{stats.byMode.design} dsn</span>
          </div>
        )}
      </aside>

      {/* Center: chat */}
      <main style={S.center}>
        {!active ? (
          <div style={S.placeholder}>
            <AgentChip code="T" size={48} tone="pulse" pulsing />
            <p style={{ marginTop: 16, color: "var(--mist)" }}>Select or start a session to brief the autonomous builder.</p>
          </div>
        ) : (
          <>
            <div style={S.centerHead}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Pill tone={MODE_TONE[active.agentMode]}>{active.agentMode}</Pill>
                  <span style={S.objective}>{active.objective}</span>
                </div>
                <div className="mono" style={S.subMeta}>
                  <WorkbenchStatusDot status={active.status} /> {active.status} · {active.costCents}¢ spent
                </div>
                <WorkbenchAutonomyModeBar
                  mode={autonomyMode}
                  saving={autonomySaving}
                  onChange={(mode) => void setWorkbenchAutonomy(mode)}
                />
                {autonomyNotice ? <div className="mono" style={S.autonomyNotice}>{autonomyNotice}</div> : null}
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {(active.status === "running" || active.status === "starting") && (
                  <button onClick={() => void stopRun()} style={S.ghostBtn} title="Stop this Workbench run">Stop</button>
                )}
                {active.status === "failed" && (
                  <button onClick={() => void rerunFailed()} style={S.ghostBtn} title="Rerun the failed attempt">Rerun failed</button>
                )}
                {active.previewUrl && (
                  <>
                  <button onClick={() => setSandboxOpen(true)} style={S.sandboxBtn} title="Open the running build in a sandbox you can test">
                    <I.external /> Test in sandbox
                  </button>
                  <a href={previewSrc(active)} target="_blank" rel="noopener noreferrer" style={S.previewLink} title="Open in a new tab" aria-label="Open sandbox in new tab">↗</a>
                  </>
                )}
                </div>
            </div>
            <WorkbenchMissionControl
              status={active.status}
              autonomyMode={autonomyMode}
              pendingApprovalId={pendingPlanApproval?.id ?? null}
              rollbackMode={active.metadata?.rollbackMode}
              events={events}
              artifacts={artifacts}
            />

            <div ref={transcriptRef} style={S.transcript}>
              {pendingPlanApproval ? (
                <WorkbenchPlanApprovalNotice
                  approval={pendingPlanApproval}
                  busy={approvalActionId === pendingPlanApproval.id}
                  onApprove={() => void resolveWorkbenchApproval(pendingPlanApproval, "approved")}
                  onReject={() => void resolveWorkbenchApproval(pendingPlanApproval, "rejected")}
                />
              ) : null}
              {messages.map((m) => <WorkbenchBubble key={m.id} role={m.role} content={m.content} />)}
              {(streaming || activity.length > 0) && (
                <div style={{ marginBottom: 12 }}>
                  {/* Build mode: suppress raw LLM code tokens from narration — activity steps cover the work.
                      Research/design modes: narration is clean prose, show it. */}
                  <AgentActivityFeed
                    steps={activity}
                    live={streaming}
                    narration={active?.agentMode !== "build" ? streamText || undefined : undefined}
                    aria-label="Workbench agent activity"
                  />
                </div>
              )}
              {streaming && streamText === "" && activity.length === 0 && llmConfigured && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--mist)", padding: "8px 4px" }}>
                  <Spinner /> <span className="mono" style={{ fontSize: 12 }}>agent working…</span>
                </div>
              )}
              {!llmConfigured && (
                <div style={{ padding: "8px 4px" }}>
                  <LlmNotConfiguredBanner />
                </div>
              )}
            </div>

            <div
              style={S.composer}
              onDragOver={(event) => {
                if (!active || uploading) return;
                event.preventDefault();
              }}
              onDrop={(event) => {
                if (!active || uploading || event.dataTransfer.files.length === 0) return;
                event.preventDefault();
                void uploadFiles(event.dataTransfer.files);
              }}
            >
              {composerError ? (
                <div style={{ width: "100%", marginBottom: 8 }}>
                  <ErrorBanner message={composerError} onDismiss={() => setComposerError("")} />
                </div>
              ) : null}
              {uploadNotice ? (
                <div
                  data-testid="workbench-upload-notice"
                  className="mono"
                  style={{ width: "100%", marginBottom: 8, fontSize: 11, color: "var(--mist)", display: "flex", justifyContent: "space-between", gap: 8 }}
                >
                  <span>{uploadNotice}</span>
                  <button onClick={() => setUploadNotice("")} style={S.iconBtn} aria-label="Dismiss upload notice">×</button>
                </div>
              ) : null}
              {!llmConfigured ? (
                <div style={{ flex: 1 }}>
                  <LlmNotConfiguredBanner />
                </div>
              ) : (
                <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => { void uploadFiles(e.target.files); e.target.value = ""; }}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                // @ts-expect-error — webkitdirectory is a non-standard but widely supported attribute
                webkitdirectory=""
                onChange={(e) => { void uploadFiles(e.target.files); e.target.value = ""; }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                onContextMenu={(e) => { e.preventDefault(); folderInputRef.current?.click(); }}
                disabled={streaming || uploading}
                style={S.iconBtn}
                title="Upload files or zips into this session (right-click to upload a folder)"
                aria-label="Upload files into the workbench session"
              >
                {uploading ? <Spinner /> : "+"}
              </button>
              <textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendMessage(); } }}
                placeholder={active.agentMode === "build" ? "Describe what to build — the agent will plan, write, run, and verify it…" : `Brief the ${active.agentMode} agent…`}
                style={S.textarea}
                disabled={streaming}
              />
              <button onClick={() => void sendMessage()} disabled={streaming || !composer.trim()} style={S.sendBtn(streaming || !composer.trim())}>
                {streaming ? <Spinner /> : <><I.arrowRight /> Send</>}
              </button>
                </>
              )}
            </div>
          </>
        )}
      </main>

      <WorkbenchEvidenceRail
        active={active}
        events={events}
        artifacts={artifacts}
        activity={activity}
        streaming={streaming}
        onRefreshSession={refreshActive}
        onOpenSandbox={() => setSandboxOpen(true)}
        onUploadFiles={(files) => void uploadFiles(files)}
      />

      {sandboxOpen && active?.previewUrl && (
        <WorkbenchSandboxModal
          url={previewSrc(active)}
          objective={active.objective}
          status={active.status}
          sessionId={active.id}
          rollbackMode={active.metadata?.rollbackMode as WorkbenchSessionMetadata["rollbackMode"] | undefined}
          rollbackDescription={typeof active.metadata?.rollbackDescription === "string" ? active.metadata.rollbackDescription : undefined}
          events={events}
          artifacts={artifacts}
          activity={activity}
          onRefreshSession={refreshActive}
          onClose={() => setSandboxOpen(false)}
        />
      )}
    </div>
  );
}

function previewSrc(session: Session): string {
  return workbenchPreviewFrameSrc(session);
}

async function postWorkbenchUpload(sessionId: string, files: File[]): Promise<{ ok: boolean; message: string }> {
  const form = new FormData();
  const paths: string[] = [];
  files.forEach((file) => {
    form.append("files", file, file.name);
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    paths.push(rel && rel.trim() ? rel : file.name);
  });
  form.append("paths", JSON.stringify(paths));

  const res = await fetch(`/api/workbench/${sessionId}/uploads`, { method: "POST", body: form });
  const data = await res.json().catch(() => null) as {
    summary?: string;
    error?: string;
    skipped?: Array<{ path: string; reason: string }>;
  } | null;
  const skippedNote = data?.skipped?.length
    ? ` Skipped: ${data.skipped.slice(0, 3).map((s) => `${s.path} (${s.reason})`).join("; ")}${data.skipped.length > 3 ? "..." : ""}`
    : "";
  if (!res.ok) {
    return { ok: false, message: data?.error ?? `Upload failed (HTTP ${res.status}).` };
  }
  return { ok: true, message: `${data?.summary ?? "Upload complete."}${skippedNote}` };
}

function sessionChipCode(session: Session): string {
  if (session.metadata?.agentRun?.agentLabel) return session.metadata.agentRun.agentLabel.slice(0, 3).toUpperCase();
  if (session.metadata?.appSolo?.agentRole) return session.metadata.appSolo.agentRole.slice(0, 3).toUpperCase();
  return MODES.find((mode) => mode.key === session.agentMode)?.code ?? "BLD";
}

export function WorkbenchPlanApprovalNotice({
  approval,
  busy,
  onApprove,
  onReject,
}: {
  approval: WorkbenchApprovalSummary;
  busy?: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <section style={S.approvalNotice} data-testid="workbench-plan-approval-notice">
      <div style={S.approvalNoticeTop}>
        <span style={S.approvalIcon}><I.shield /></span>
        <div style={{ minWidth: 0 }}>
          <div style={S.approvalTitle}>Workbench plan needs approval</div>
          <p style={S.approvalBody}>
            Review the plan below, then continue from here. Full autonomous mode skips this first plan pause while keeping risky external actions gated.
          </p>
        </div>
      </div>
      {approval.previewContent ? (
        <pre style={S.approvalPreview}>{approval.previewContent}</pre>
      ) : null}
      <div style={S.approvalActions}>
        <button type="button" onClick={onReject} disabled={busy} style={S.rejectBtn}>
          {busy ? <Spinner /> : <I.x />} Reject
        </button>
        <button type="button" onClick={onApprove} disabled={busy} style={S.approveBtn}>
          {busy ? <Spinner /> : <I.check />} Approve & continue
        </button>
      </div>
    </section>
  );
}

export function WorkbenchAutonomyModeBar({
  mode,
  saving,
  onChange,
}: {
  mode: CompanyAutonomyMode;
  saving: boolean;
  onChange: (mode: CompanyAutonomyMode) => void;
}) {
  return (
    <section style={S.autonomyCard} data-testid="workbench-autonomy-mode-bar" aria-label="Workbench autonomy mode">
      <div style={S.autonomyCardTop}>
        <span className="mono" style={S.autonomyLabel}>autonomy</span>
        <span style={S.autonomySafety}>Safe reversible work runs; spend, email, CRM, deploys, deletes, and social posts still need approval.</span>
      </div>
      <div style={S.autonomyModes} role="radiogroup" aria-label="Workbench autonomy mode selector">
        {(["manual", "supervised", "autonomous"] as CompanyAutonomyMode[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={mode === candidate}
            onClick={() => onChange(candidate)}
            disabled={saving}
            style={S.autonomyModeButton(mode === candidate, candidate)}
            title={autonomyModeCopy[candidate]}
          >
            {saving && mode === candidate ? <Spinner /> : null}
            {labelMode(candidate)}
          </button>
        ))}
      </div>
      <p style={S.autonomyExplain}>{autonomyModeCopy[mode]}</p>
    </section>
  );
}

export function WorkbenchMissionControl({
  status,
  autonomyMode,
  pendingApprovalId,
  rollbackMode,
  events,
  artifacts,
}: {
  status: SessionStatus;
  autonomyMode: CompanyAutonomyMode;
  pendingApprovalId?: string | null;
  rollbackMode?: WorkbenchSessionMetadata["rollbackMode"];
  events: WbEvent[];
  artifacts: WbArtifact[];
}) {
  const fileCount = artifacts.filter((artifact) => artifact.kind === "file" || Boolean(artifact.path)).length
    + events.filter((event) => event.type === "file").length;
  const screenshotCount = artifacts.filter((artifact) => artifact.kind === "screenshot" || artifact.mimeType.startsWith("image/")).length;
  const terminalCount = events.filter((event) => Boolean(event.command) || event.type === "shell").length;
  const checkpointCount = events.filter((event) => typeof event.metadata?.checkpointId === "string").length;
  const testEvents = events.filter((event) => event.type === "test" || /test|verify/i.test(event.title));
  const latestTest = testEvents.at(-1);
  const testsLabel = latestTest
    ? latestTest.status === "failed" ? "tests failed" : latestTest.status === "completed" ? "tests passed" : "tests running"
    : "tests pending";
  const rollbackLabel = rollbackMode === "provider_native"
    ? "provider-native rollback"
    : rollbackMode === "text_files_only"
      ? "text-files-only rollback"
      : "rollback not proven";

  return (
    <section style={S.missionControl} data-testid="workbench-mission-control" aria-label="Workbench mission control">
      <div style={S.missionControlHead}>
        <span className="mono" style={S.missionKicker}>mission control</span>
        <span className="mono" style={S.missionStatus}>{status}</span>
      </div>
      <div style={S.missionGrid}>
        <MissionCell label="mode" value={autonomyMode} tone={autonomyMode === "autonomous" ? "pulse" : "neutral"} />
        <MissionCell
          label="approval"
          value={pendingApprovalId ? `Approval ${pendingApprovalId}` : "clear"}
          tone={pendingApprovalId ? "approval" : "neutral"}
        />
        <MissionCell label="files" value={`${fileCount} ${fileCount === 1 ? "file" : "files"}`} tone={fileCount ? "pulse" : "neutral"} />
        <MissionCell label="screenshots" value={`${screenshotCount} ${screenshotCount === 1 ? "shot" : "shots"}`} tone={screenshotCount ? "pulse" : "neutral"} />
        <MissionCell label="terminal" value={`${terminalCount} terminal`} tone={terminalCount ? "pulse" : "neutral"} />
        <MissionCell label="tests" value={testsLabel} tone={testsLabel.includes("failed") ? "danger" : latestTest ? "pulse" : "neutral"} />
        <MissionCell label="rollback" value={rollbackLabel} tone={rollbackMode === "provider_native" ? "pulse" : rollbackMode ? "approval" : "neutral"} />
        <MissionCell label="checkpoints" value={`${checkpointCount} ${checkpointCount === 1 ? "checkpoint" : "checkpoints"}`} tone={checkpointCount ? "pulse" : "neutral"} />
      </div>
    </section>
  );
}

function MissionCell({ label, value, tone }: { label: string; value: string; tone: "pulse" | "approval" | "danger" | "neutral" }) {
  return (
    <div style={S.missionCell} data-tone={tone}>
      <span className="mono" style={S.missionCellLabel}>{label}</span>
      <span style={S.missionCellValue}>{value}</span>
    </div>
  );
}

const autonomyModeCopy: Record<CompanyAutonomyMode, string> = {
  manual: "Manual: agents research and draft. External side effects and risky actions pause for approval.",
  supervised: "Supervised: safe internal/reversible work can run; external writes and high-risk actions pause. This is the default.",
  autonomous: "Autonomous: low-risk, reversible, connected work runs without the first plan pause. Risky external actions remain gated.",
};

function labelMode(mode: CompanyAutonomyMode): string {
  if (mode === "manual") return "Manual";
  if (mode === "supervised") return "Supervised";
  return "Autonomous";
}

// ── Inline styles (house design tokens) ───────────────────────────────────────

const border = "1px solid rgba(255,255,255,.07)";
const surface = "rgba(255,255,255,.02)";

const S = {
  root: { display: "grid", gridTemplateColumns: "280px 1fr 360px", height: "calc(100vh - 64px)", background: "var(--obsidian)", color: "var(--bone)" } as React.CSSProperties,
  sidebar: { borderRight: border, display: "flex", flexDirection: "column", minHeight: 0 } as React.CSSProperties,
  sidebarHead: { padding: "16px 14px 12px", borderBottom: border } as React.CSSProperties,
  kicker: { fontSize: 10, letterSpacing: ".18em", color: "var(--haze)" } as React.CSSProperties,
  surfaceTabs: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 12 } as React.CSSProperties,
  surfaceTab: (active: boolean) => ({
    padding: "7px 0", fontSize: 12, fontWeight: 700, cursor: "pointer", borderRadius: 7,
    border: active ? "1px solid rgba(110,231,183,.34)" : border,
    background: active ? "rgba(110,231,183,.08)" : "transparent",
    color: active ? "var(--pulse)" : "var(--mist)",
  }) as React.CSSProperties,
  modeTabs: { display: "flex", gap: 6, marginTop: 10 } as React.CSSProperties,
  modeTab: (active: boolean, tone: string) => ({
    flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 600, cursor: "pointer", borderRadius: 7,
    border: active ? `1px solid var(--${tone})` : border,
    background: active ? `color-mix(in oklab, var(--${tone}) 12%, transparent)` : "transparent",
    color: active ? `var(--${tone})` : "var(--mist)", transition: "all .18s ease",
  }) as React.CSSProperties,
  agentList: { display: "grid", gridTemplateColumns: "1fr", gap: 5, marginTop: 10, maxHeight: 230, overflowY: "auto", paddingRight: 2 } as React.CSSProperties,
  agentButton: (active: boolean) => ({
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
    padding: "7px 8px", borderRadius: 7, border: active ? "1px solid rgba(110,231,183,.3)" : border,
    background: active ? "rgba(110,231,183,.06)" : "rgba(255,255,255,.018)",
    color: active ? "var(--pulse)" : "var(--mist)", fontSize: 12, cursor: "pointer", minWidth: 0,
  }) as React.CSSProperties,
  sessionList: { flex: 1, overflowY: "auto", padding: 8, minHeight: 0 } as React.CSSProperties,
  empty: { fontSize: 12, color: "var(--haze)", padding: 12, lineHeight: 1.5 } as React.CSSProperties,
  iconBtn: {
    width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center",
    background: "rgba(255,255,255,.03)", border, borderRadius: 7, color: "var(--mist)", cursor: "pointer",
  } as React.CSSProperties,
  sessionWrap: (active: boolean) => ({
    position: "relative", display: "flex", alignItems: "stretch", gap: 4, marginBottom: 4,
    borderRadius: 8, border: active ? "1px solid rgba(110,231,183,.3)" : "1px solid transparent",
    background: active ? "rgba(110,231,183,.05)" : "transparent", transition: "background .15s ease",
  }) as React.CSSProperties,
  sessionRow: {
    width: "100%", textAlign: "left", display: "flex", flexDirection: "column", gap: 6, padding: "10px 10px",
    background: "transparent", border: 0, cursor: "pointer", minWidth: 0,
  } as React.CSSProperties,
  deleteBtn: {
    width: 28, flexShrink: 0, border: 0, borderLeft: "1px solid rgba(255,255,255,.05)",
    background: "transparent", color: "var(--haze)", cursor: "pointer", fontSize: 18, borderRadius: "0 8px 8px 0",
  } as React.CSSProperties,
  sessionTitle: { fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 190 } as React.CSSProperties,
  sessionMeta: { display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--mist)" } as React.CSSProperties,
  statsBar: { display: "flex", gap: 12, padding: "10px 14px", borderTop: border, fontSize: 11, color: "var(--mist)" } as React.CSSProperties,
  center: { display: "flex", flexDirection: "column", minHeight: 0 } as React.CSSProperties,
  placeholder: { flex: 1, display: "grid", placeItems: "center", textAlign: "center" } as React.CSSProperties,
  centerHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, padding: "16px 20px", borderBottom: border } as React.CSSProperties,
  objective: { fontSize: 15, fontWeight: 600 } as React.CSSProperties,
  subMeta: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--mist)", marginTop: 8 } as React.CSSProperties,
  autonomyCard: { marginTop: 10, border, borderRadius: 10, background: "rgba(255,255,255,.022)", padding: 10, maxWidth: 650 } as React.CSSProperties,
  autonomyCardTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 } as React.CSSProperties,
  autonomyLabel: { fontSize: 10, color: "var(--haze)", textTransform: "uppercase", letterSpacing: ".08em" } as React.CSSProperties,
  autonomySafety: { color: "var(--mist)", fontSize: 10, lineHeight: 1.35, textAlign: "right" } as React.CSSProperties,
  autonomyModes: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 } as React.CSSProperties,
  autonomyModeButton: (active: boolean, mode: CompanyAutonomyMode) => ({
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    height: 30, padding: "0 8px", borderRadius: 8,
    border: active ? "1px solid rgba(110,231,183,.42)" : border,
    background: active ? "rgba(110,231,183,.1)" : "rgba(255,255,255,.025)",
    color: active ? "var(--pulse)" : mode === "manual" ? "var(--haze)" : "var(--mist)",
    fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap",
  }) as React.CSSProperties,
  autonomyExplain: { margin: "8px 0 0", color: "var(--haze)", fontSize: 10, lineHeight: 1.4 } as React.CSSProperties,
  autonomyNotice: { marginTop: 6, fontSize: 10, color: "var(--mist)", lineHeight: 1.4, maxWidth: 520 } as React.CSSProperties,
  missionControl: { borderBottom: border, padding: "10px 20px 12px", background: "rgba(255,255,255,.012)" } as React.CSSProperties,
  missionControlHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 } as React.CSSProperties,
  missionKicker: { fontSize: 10, color: "var(--haze)", textTransform: "uppercase", letterSpacing: ".11em" } as React.CSSProperties,
  missionStatus: { fontSize: 10, color: "var(--mist)", textTransform: "uppercase", letterSpacing: ".11em" } as React.CSSProperties,
  missionGrid: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 7 } as React.CSSProperties,
  missionCell: {
    minWidth: 0, border, borderRadius: 8, padding: "8px 9px",
    background: "rgba(255,255,255,.018)", display: "grid", gap: 3,
  } as React.CSSProperties,
  missionCellLabel: { color: "var(--haze)", fontSize: 9, textTransform: "uppercase", letterSpacing: ".08em" } as React.CSSProperties,
  missionCellValue: { color: "var(--bone)", fontSize: 12, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  previewLink: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ember)", textDecoration: "none", padding: "6px 10px", border: "1px solid rgba(251,146,60,.3)", borderRadius: 7 } as React.CSSProperties,
  ghostBtn: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    height: 32, padding: "0 12px", borderRadius: 8, border,
    background: "rgba(255,255,255,.03)", color: "var(--mist)", fontSize: 12,
    cursor: "pointer", whiteSpace: "nowrap",
  } as React.CSSProperties,
  transcript: { flex: 1, overflowY: "auto", padding: "20px", minHeight: 0 } as React.CSSProperties,
  approvalNotice: {
    marginBottom: 14, padding: 14, borderRadius: 12,
    border: "1px solid rgba(110,231,183,.28)",
    background: "linear-gradient(135deg, rgba(110,231,183,.11), rgba(255,255,255,.025))",
    boxShadow: "0 18px 42px rgba(0,0,0,.18)",
  } as React.CSSProperties,
  approvalNoticeTop: { display: "flex", gap: 11, alignItems: "flex-start" } as React.CSSProperties,
  approvalIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    color: "var(--pulse)", background: "rgba(110,231,183,.1)",
    border: "1px solid rgba(110,231,183,.2)",
  } as React.CSSProperties,
  approvalTitle: { fontSize: 14, fontWeight: 800, color: "var(--bone)" } as React.CSSProperties,
  approvalBody: { margin: "5px 0 0", color: "var(--mist)", fontSize: 12, lineHeight: 1.45 } as React.CSSProperties,
  approvalPreview: {
    margin: "12px 0 0", maxHeight: 190, overflow: "auto", whiteSpace: "pre-wrap",
    border: "1px solid rgba(255,255,255,.08)", borderRadius: 10,
    padding: "10px 11px", background: "rgba(0,0,0,.2)", color: "var(--mist)",
    fontSize: 11, lineHeight: 1.45, fontFamily: "var(--mono)",
  } as React.CSSProperties,
  approvalActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12, flexWrap: "wrap" } as React.CSSProperties,
  approveBtn: {
    display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px",
    borderRadius: 8, border: "none", background: "var(--pulse)", color: "#04140d",
    fontSize: 12, fontWeight: 800, cursor: "pointer",
  } as React.CSSProperties,
  rejectBtn: {
    display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px",
    borderRadius: 8, border, background: "rgba(255,255,255,.03)", color: "var(--mist)",
    fontSize: 12, fontWeight: 700, cursor: "pointer",
  } as React.CSSProperties,
  composer: { display: "flex", flexWrap: "wrap", gap: 10, padding: "14px 20px", borderTop: border } as React.CSSProperties,
  textarea: { flex: 1, resize: "none", minHeight: 52, maxHeight: 140, background: surface, border, borderRadius: 10, padding: "12px 14px", color: "var(--bone)", fontSize: 14, fontFamily: "var(--display)", outline: "none" } as React.CSSProperties,
  sendBtn: (disabled: boolean) => ({
    display: "inline-flex", alignItems: "center", gap: 6, padding: "0 18px", borderRadius: 10, border: "none",
    background: disabled ? "rgba(255,255,255,.06)" : "var(--pulse)", color: disabled ? "var(--haze)" : "#04140d",
    fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", transition: "background .18s ease",
  }) as React.CSSProperties,
  sandboxBtn: {
    display: "inline-flex", alignItems: "center", gap: 6, padding: "0 14px", height: 32, borderRadius: 8,
    background: "var(--pulse)", color: "var(--obsidian)", border: "none", fontWeight: 600, fontSize: 12,
    cursor: "pointer", whiteSpace: "nowrap",
  } as React.CSSProperties,
};
