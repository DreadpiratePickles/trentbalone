"use client";

/**
 * Command - Trent's primary chat surface.
 *
 * This file owns state, loading, orchestration streaming, and persistence-aware
 * trace replay wiring. Presentational pieces live in command-client-parts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArtifactDrawer,
  BlankState,
  Composer,
  ConversationsRail,
  MODEL_OPTIONS,
  TopToolbar,
  Transcript,
  fmtDateLabel,
  type ModelKey,
  type RunMode,
} from "@/components/command-client-parts";
import { ErrorBanner, LlmNotConfiguredBanner } from "@/components/error-banner";
import { useRuntimeHealth } from "@/components/runtime-health";
import { useStatusToast } from "@/components/status-toast";
import { readApiError } from "@/lib/read-api-error";
import {
  applyOrchestrationActivityEvent,
  createOrchestrationActivityState,
  type ActivityStep,
} from "@/components/agent-activity";
import { OrchestratorTraceDrawer } from "@/components/orchestrator-trace-drawer";
import { isPollTerminalRunStatus } from "@/lib/orchestrator-run-reconcile";
import { McpToolVisibilityPanel } from "@/components/mcp-tool-visibility-panel";
import type { Artifact, CeoMessage, CeoSuggestion } from "@/lib/types";
import type { CeoChatMode } from "@/lib/ceo-chat-mode";
import {
  ORCHESTRATION_TRANSCRIPT_EVENTS,
  applyOrchestrationTranscriptEvent,
  createOrchestrationTranscript,
  type CommandRun,
  type OrchStreamPayload,
} from "@/lib/command-orchestration-transcript";

export function CommandClient({ companyId, initialPrompt }: { companyId: string; initialPrompt?: string }) {
  const [messages, setMessages] = useState<CeoMessage[]>([]);
  const [suggestions, setSuggestions] = useState<CeoSuggestion[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [mode, setMode] = useState<RunMode>("agent");
  const [model, setModel] = useState<ModelKey>("claude-sonnet-4-5");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [input, setInput] = useState(initialPrompt ?? "");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [selectedTraceRunId, setSelectedTraceRunId] = useState<string | null>(null);
  const [orchRuns, setOrchRuns] = useState<CommandRun[]>([]);
  const [sendError, setSendError] = useState("");
  const [messageActivity, setMessageActivity] = useState<Record<string, ActivityStep[]>>({});
  const [liveMessageId, setLiveMessageId] = useState<string | null>(null);

  const { readiness, loading: healthLoading } = useRuntimeHealth();
  const { pushError } = useStatusToast();
  const llmConfigured = healthLoading ? true : (readiness?.llm ?? false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/ceo?companyId=${companyId}`);
    if (res.ok) {
      const data = await res.json();
      setMessages(data.messages ?? []);
      setSuggestions(data.suggestions ?? []);
      setArtifacts(data.artifacts ?? []);
    }

    const oRes = await fetch(`/api/companies/${companyId}/orchestrate`);
    if (oRes.ok) {
      const od = await oRes.json() as { runs: CommandRun[] };
      setOrchRuns(od.runs ?? []);
    }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 320)}px`;
  }, [input]);

  async function send(prompt?: string) {
    const text = (prompt ?? input).trim();
    if (!text || sending) return;
    if (!llmConfigured) {
      setSendError("LLM not configured — see docs/RUN.md");
      return;
    }
    setSendError("");
    setSending(true);
    setStreaming(false);
    if (!prompt) setInput("");

    const optimistic: CeoMessage = {
      id: `opt-${Date.now()}`,
      companyId,
      direction: "from_owner",
      kind: "chat",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    const streamTimer = setTimeout(() => setStreaming(true), 350);

    try {
      if (mode !== "ask") {
        await sendOrchestrated(text, optimistic);
      } else {
        await sendAsk(text, optimistic);
      }
    } finally {
      clearTimeout(streamTimer);
      setStreaming(false);
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  async function sendOrchestrated(text: string, optimistic: CeoMessage) {
    const isAutonomous = mode === "autonomous";
    const res = await fetch(`/api/companies/${companyId}/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: text,
        trigger: isAutonomous ? "manual" : "delegated",
        fullTeam: isAutonomous,
      }),
    });
    if (!res.ok) {
      const message = await readApiError(res);
      setSendError(message);
      pushError(message);
      setMessages((prev) => prev.filter((message) => message.id !== optimistic.id));
      return;
    }
    const data = await res.json() as { run: CommandRun };
    const run = data.run;
    const replyId = `local-run-${run?.id ?? Date.now()}`;
    const reply: CeoMessage = {
      id: replyId,
      companyId,
      direction: "from_ceo",
      kind: "autopilot_update",
      content: isAutonomous
        ? `Autonomous company run started (${run?.id ?? "-"}).\n\nEvery specialist seat is taking on its part. I will report back with results, artifacts, blockers, costs, and suggested next actions.`
        : `Orchestrator run started (${run?.id ?? "-"}).\n\nPlanning specialist work now...`,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev.filter((message) => message.id !== optimistic.id), reply]);
    setOrchRuns((prev) => run ? [run, ...prev] : prev);
    if (run) await streamOrchestrationRun(run.id, replyId);
    await load();
  }

  async function sendAsk(text: string, optimistic: CeoMessage) {
    const ceoMode: CeoChatMode = mode === "ask" ? "gen" : "org";
    const res = await fetch("/api/ceo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId, message: text, mode: ceoMode }),
    });
    if (!res.ok) {
      const message = await readApiError(res);
      setSendError(message);
      pushError(message);
      setMessages((prev) => prev.filter((message) => message.id !== optimistic.id));
      return;
    }

    const data = await res.json() as {
      ceoMessage: CeoMessage;
      suggestions?: CeoSuggestion[];
      createdArtifacts?: Artifact[];
    };
    setMessages((prev) => [...prev.filter((message) => message.id !== optimistic.id), data.ceoMessage]);
    if (data.suggestions?.length) setSuggestions((prev) => [...(data.suggestions ?? []), ...prev]);
    if (data.createdArtifacts?.length) setArtifacts((prev) => [...(data.createdArtifacts ?? []), ...prev]);
  }

  async function streamOrchestrationRun(runId: string, messageId: string) {
    setLiveMessageId(messageId);
    // RC2 fix (Fix Plan Slice 1): the stream is no longer trusted to deliver a
    // terminal event. On SSE error we reconnect with backoff (2 tries); after
    // that — or after 45s of stream silence — we fall back to polling the
    // persisted run snapshot until a terminal status, then render the saved
    // CEO report. The UI must never stay "loading" while the backend is done.
    await new Promise<void>((resolve) => {
      const transcript = createOrchestrationTranscript(runId);
      const activityState = createOrchestrationActivityState(runId);
      // Poll-terminal = the shared run-truth set (terminal OR paused-for-approval).
      // awaiting_approval is paused, NOT lost contact, so the watchdog must stop on
      // it too — sourced from isPollTerminalRunStatus so there is one definition.
      const SILENCE_MS = 45_000;
      const POLL_MS = 3_000;
      const POLL_LIMIT = 200; // ~10 minutes of polling before giving up
      let es: EventSource | null = null;
      let silenceTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let polling = false;
      let reconnects = 0;

      const update = (content: string) => {
        setMessages((prev) => prev.map((message) => message.id === messageId ? { ...message, content } : message));
      };
      const updateActivity = () => {
        setMessageActivity((prev) => ({ ...prev, [messageId]: [...activityState.steps] }));
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        es?.close();
        setLiveMessageId((current) => (current === messageId ? null : current));
        resolve();
      };
      const applyRunStatus = (runStatus?: string, summary?: string) => {
        if (!runStatus) return;
        setOrchRuns((prev) => prev.map((run) => run.id === runId ? {
          ...run,
          status: runStatus as CommandRun["status"],
          summary: summary ?? run.summary,
        } : run));
      };
      const resetSilenceWatchdog = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          es?.close();
          void pollUntilTerminal("stream went silent");
        }, SILENCE_MS);
      };

      async function pollUntilTerminal(reason: string) {
        if (settled || polling) return;
        polling = true;
        if (silenceTimer) clearTimeout(silenceTimer);
        activityState.steps.push({
          id: `${runId}-poll`,
          icon: "status",
          verb: "Stream interrupted",
          target: `Following the run via status polling (${reason}).`,
          status: "running",
        });
        updateActivity();
        for (let i = 0; i < POLL_LIMIT && !settled; i++) {
          try {
            const res = await fetch(`/api/companies/${companyId}/orchestrate?runId=${encodeURIComponent(runId)}`);
            if (res.ok) {
              const data = await res.json() as {
                run?: { status?: string; summary?: string; reconciled?: boolean; staleSnapshotDetected?: boolean; reconciledFrom?: string };
              };
              const status = data.run?.status;
              // Dev/test diagnostic: when the snapshot was reconciled from durable
              // trace/step state, the persisted run row disagreed with the truth.
              // Surface it to logs only — never confuse the founder in the UI.
              if (data.run?.staleSnapshotDetected && process.env.NODE_ENV !== "production") {
                console.debug("[orchestrate] reconciled stale run snapshot", {
                  runId,
                  status,
                  reconciledFrom: data.run.reconciledFrom,
                });
              }
              if (isPollTerminalRunStatus(status)) {
                const summary = data.run?.summary;
                const headline = status === "completed" ? "Run completed. Saved CEO report:" : `Run ${status}.`;
                transcript.lines.push("", headline, ...(summary ? ["", summary] : []));
                update(transcript.lines.join("\n"));
                activityState.steps = activityState.steps.map((step) => step.id === `${runId}-poll`
                  ? { ...step, status: status === "completed" ? "completed" as const : status === "awaiting_approval" ? "waiting" as const : "failed" as const, target: `Run ${status} (recovered by polling).` }
                  : step);
                updateActivity();
                applyRunStatus(status, summary);
                finish();
                return;
              }
            }
          } catch {
            // Transient poll failure — keep trying until the limit.
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        if (!settled) {
          transcript.lines.push("", "Lost contact with the run. It may still be working — its saved CEO report will appear in the run list when it finishes.");
          update(transcript.lines.join("\n"));
          finish();
        }
      }

      const apply = (eventName: string, event: MessageEvent) => {
        resetSilenceWatchdog();
        const payload = safeJson<OrchStreamPayload>(event.data);
        const next = applyOrchestrationTranscriptEvent(transcript, eventName, payload);
        const activity = applyOrchestrationActivityEvent(activityState, eventName, payload);
        updateActivity();
        update(next.content);
        if (activity.runStatus ?? next.runStatus) {
          const runStatus = activity.runStatus ?? next.runStatus;
          applyRunStatus(runStatus, activity.summary ?? next.summary ?? next.detail);
        }
        if (next.done || activity.done) finish();
      };

      const connect = () => {
        if (settled || polling) return;
        const source = new EventSource(`/api/companies/${companyId}/orchestrate/stream?runId=${encodeURIComponent(runId)}`);
        es = source;
        resetSilenceWatchdog();
        ORCHESTRATION_TRANSCRIPT_EVENTS.forEach((eventName) => {
          source.addEventListener(eventName, (event) => apply(eventName, event as MessageEvent));
        });
        source.onerror = () => {
          source.close();
          if (settled || polling) return;
          if (reconnects < 2) {
            reconnects += 1;
            setTimeout(connect, reconnects * 1_500);
          } else {
            void pollUntilTerminal("stream disconnected");
          }
        };
      };

      connect();
    });
  }

  const sessionsByDay = useMemo(() => {
    const map = new Map<string, CeoMessage[]>();
    for (const message of messages) {
      const key = fmtDateLabel(message.createdAt);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(message);
    }
    return Array.from(map.entries());
  }, [messages]);

  const selectedModel = MODEL_OPTIONS.find((candidate) => candidate.key === model)!;

  if (loading) {
    return (
      <div data-testid="command-console-loading" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 400 }}>
        <div className="spinner" style={{ width: 22, height: 22, borderWidth: 2 }} />
      </div>
    );
  }

  return (
    <div data-testid="command-console" style={{
      display: "grid",
      gridTemplateColumns: sideOpen ? "260px 1fr" : "44px 1fr",
      gap: 0,
      minHeight: "calc(100vh - 160px)",
      transition: "grid-template-columns .2s",
    }}>
      <ConversationsRail
        sessionsByDay={sessionsByDay}
        orchRuns={orchRuns}
        collapsed={!sideOpen}
        onOpenTrace={setSelectedTraceRunId}
        onToggle={() => setSideOpen((value) => !value)}
        onNewChat={() => {
          setMessages([]);
          setInput("");
          textareaRef.current?.focus();
        }}
      />

      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
        <TopToolbar
          mode={mode}
          setMode={setMode}
          model={model}
          setModel={setModel}
          modelPickerOpen={modelPickerOpen}
          setModelPickerOpen={setModelPickerOpen}
          selectedModel={selectedModel}
        />
        <div style={{ padding: "0 24px" }}>
          <McpToolVisibilityPanel companyId={companyId} compact />
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto", padding: "0 24px" }}>
          {messages.length === 0 ? (
            <BlankState
              mode={mode}
              onPickPrompt={(picked) => {
                setInput(picked);
                textareaRef.current?.focus();
              }}
              suggestions={suggestions}
            />
          ) : (
            <Transcript
              sessionsByDay={sessionsByDay}
              streaming={streaming}
              artifacts={artifacts}
              onOpenArtifact={setSelectedArtifact}
              bottomRef={bottomRef}
              messageActivity={messageActivity}
              liveMessageId={liveMessageId}
            />
          )}
        </div>

        <div style={{ padding: "0 24px 8px", maxWidth: 760, margin: "0 auto", width: "100%" }}>
          {sendError ? (
            <ErrorBanner message={sendError} onDismiss={() => setSendError("")} />
          ) : !llmConfigured ? (
            <LlmNotConfiguredBanner />
          ) : null}
        </div>

        <Composer
          input={input}
          setInput={setInput}
          onSend={() => void send()}
          sending={sending}
          mode={mode}
          textareaRef={textareaRef}
          disabled={!llmConfigured}
        />
      </div>

      {selectedArtifact && (
        <ArtifactDrawer artifact={selectedArtifact} onClose={() => setSelectedArtifact(null)} />
      )}

      {selectedTraceRunId && (
        <OrchestratorTraceDrawer
          companyId={companyId}
          runId={selectedTraceRunId}
          onClose={() => setSelectedTraceRunId(null)}
        />
      )}
    </div>
  );
}

function safeJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}
