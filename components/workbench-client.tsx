"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I, Pill, Spinner, AgentChip } from "@/components/ui";
import { WorkbenchEvidenceRail } from "@/components/workbench-evidence-rail";
import { WorkbenchSandboxModal } from "@/components/workbench-sandbox-modal";
import { AgentActivityFeed, mapWorkbenchChunk, type ActivityStep } from "@/components/agent-activity";
import { WorkbenchBubble, WorkbenchNewSession, WorkbenchStatusDot } from "@/components/workbench-session-parts";
import { buildWorkbenchCreateRequestBody } from "@/lib/workbench-session-request";
import { workbenchPreviewFrameSrc } from "@/lib/workbench-preview-url";
import { readApiError } from "@/lib/read-api-error";
import { ErrorBanner, LlmNotConfiguredBanner } from "@/components/error-banner";
import { useRuntimeHealth } from "@/components/runtime-health";
import { useStatusToast } from "@/components/status-toast";

// ── Types (mirror lib/types-workbench + lib/workbench-agent chunk protocol) ──────

type AgentMode = "build" | "research" | "design";
type SessionStatus = "queued" | "starting" | "running" | "paused" | "completed" | "failed" | "cancelled";

type Session = {
  id: string;
  companyId: string;
  agentMode: AgentMode;
  status: SessionStatus;
  objective: string;
  previewUrl?: string;
  messageCount?: number;
  costCents: number;
  updatedAt: string;
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

export function WorkbenchClient({ companyId }: { companyId: string }) {
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

  const { readiness, loading: healthLoading } = useRuntimeHealth();
  const { pushError } = useStatusToast();
  // Don't show "not configured" while the health check is still in flight
  const llmConfigured = healthLoading ? true : (readiness?.llm ?? false);

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const autoOpenedRef = useRef<string | null>(null);

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

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);

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

  const createSession = useCallback(async (objective: string, mode: AgentMode): Promise<boolean> => {
    if (!llmConfigured) {
      setSessionError("LLM not configured — see docs/RUN.md");
      return false;
    }
    setCreating(true);
    setSessionError("");
    try {
      const res = await fetch(`/api/workbench`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildWorkbenchCreateRequestBody({ companyId, objective, agentMode: mode })),
      });
      if (!res.ok) {
        const message = await readApiError(res);
        setSessionError(message);
        pushError(message);
        return false;
      }
      const { session } = await res.json();
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
    if (activeId) await loadSession(activeId);
  }, [activeId, loadSession, refreshSessions]);

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

  const filteredSessions = sessions.filter((s) => s.agentMode === modeFilter);

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
          <div style={S.modeTabs}>
            {MODES.map((m) => (
              <button key={m.key} onClick={() => setModeFilter(m.key)} style={S.modeTab(modeFilter === m.key, MODE_TONE[m.key])} title={m.blurb}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <WorkbenchNewSession
          mode={modeFilter}
          creating={creating}
          llmConfigured={llmConfigured}
          onCreate={createSession}
        />

        {sessionError ? (
          <div style={{ padding: "8px 14px 0" }}>
            <ErrorBanner message={sessionError} onDismiss={() => setSessionError("")} />
          </div>
        ) : null}

        <div style={S.sessionList}>
          {filteredSessions.length === 0 && <p style={S.empty}>No {modeFilter} sessions yet. Describe an objective above to start one.</p>}
          {filteredSessions.map((s) => (
            <div key={s.id} style={S.sessionWrap(s.id === activeId)}>
              <button onClick={() => void loadSession(s.id)} style={S.sessionRow}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AgentChip code={MODES.find((m) => m.key === s.agentMode)?.code ?? "BLD"} size={24} tone={MODE_TONE[s.agentMode]} />
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

            <div ref={transcriptRef} style={S.transcript}>
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

            <div style={S.composer}>
              {composerError ? (
                <div style={{ width: "100%", marginBottom: 8 }}>
                  <ErrorBanner message={composerError} onDismiss={() => setComposerError("")} />
                </div>
              ) : null}
              {!llmConfigured ? (
                <div style={{ flex: 1 }}>
                  <LlmNotConfiguredBanner />
                </div>
              ) : (
                <>
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
      />

      {sandboxOpen && active?.previewUrl && (
        <WorkbenchSandboxModal
          url={previewSrc(active)}
          objective={active.objective}
          status={active.status}
          sessionId={active.id} events={events} artifacts={artifacts} activity={activity} onRefreshSession={refreshActive}
          onClose={() => setSandboxOpen(false)}
        />
      )}
    </div>
  );
}

function previewSrc(session: Session): string {
  return workbenchPreviewFrameSrc(session);
}

// ── Inline styles (house design tokens) ───────────────────────────────────────

const border = "1px solid rgba(255,255,255,.07)";
const surface = "rgba(255,255,255,.02)";

const S = {
  root: { display: "grid", gridTemplateColumns: "280px 1fr 360px", height: "calc(100vh - 64px)", background: "var(--obsidian)", color: "var(--bone)" } as React.CSSProperties,
  sidebar: { borderRight: border, display: "flex", flexDirection: "column", minHeight: 0 } as React.CSSProperties,
  sidebarHead: { padding: "16px 14px 12px", borderBottom: border } as React.CSSProperties,
  kicker: { fontSize: 10, letterSpacing: ".18em", color: "var(--haze)" } as React.CSSProperties,
  modeTabs: { display: "flex", gap: 6, marginTop: 10 } as React.CSSProperties,
  modeTab: (active: boolean, tone: string) => ({
    flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 600, cursor: "pointer", borderRadius: 7,
    border: active ? `1px solid var(--${tone})` : border,
    background: active ? `color-mix(in oklab, var(--${tone}) 12%, transparent)` : "transparent",
    color: active ? `var(--${tone})` : "var(--mist)", transition: "all .18s ease",
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
  previewLink: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ember)", textDecoration: "none", padding: "6px 10px", border: "1px solid rgba(251,146,60,.3)", borderRadius: 7 } as React.CSSProperties,
  ghostBtn: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    height: 32, padding: "0 12px", borderRadius: 8, border,
    background: "rgba(255,255,255,.03)", color: "var(--mist)", fontSize: 12,
    cursor: "pointer", whiteSpace: "nowrap",
  } as React.CSSProperties,
  transcript: { flex: 1, overflowY: "auto", padding: "20px", minHeight: 0 } as React.CSSProperties,
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
