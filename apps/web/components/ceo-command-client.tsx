"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { CodeBlock, NarrationText } from "@/components/agent-activity";
import { CommandChatModeToggle } from "@/components/command-chat-mode-toggle";
import { I } from "@/components/ui";
import type { CeoChatMode } from "@/lib/ceo-chat-mode";
import type { Artifact, ArtifactExportFormat, CeoMessage, CeoSuggestion } from "@/lib/types";

// ── Category config ───────────────────────────────────────────────────────────

const SUGGESTION_CATEGORY: Record<
  CeoSuggestion["category"],
  { label: string; color: string; emoji: string }
> = {
  outreach:   { label: "Outreach",   color: "#06B6D4", emoji: "📣" },
  content:    { label: "Content",    color: "#6366F1", emoji: "✍️" },
  product:    { label: "Product",    color: "#10B981", emoji: "🔧" },
  operations: { label: "Operations", color: "#F97316", emoji: "⚙️" },
  finance:    { label: "Finance",    color: "#84CC16", emoji: "💰" },
  other:      { label: "Action",     color: "#A78BFA", emoji: "◈"  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// ── Main client ───────────────────────────────────────────────────────────────

export function CeoCommandClient({ companyId }: { companyId: string }) {
  const [messages, setMessages] = useState<CeoMessage[]>([]);
  const [mode, setMode] = useState<CeoChatMode>("org");
  const [suggestions, setSuggestions] = useState<CeoSuggestion[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [autopilotOn, setAutopilotOn] = useState(true);
  const [lastUnderstood, setLastUnderstood] = useState<{
    intent?: string; routedTo?: string; willDo?: string; approvalRequired?: boolean;
  } | null>(null);
  const [lastCreatedCount, setLastCreatedCount] = useState(0);
  const [lastCreatedArtifactCount, setLastCreatedArtifactCount] = useState(0);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [streamingReply, setStreamingReply] = useState(false);
  const [lastTaskId, setLastTaskId] = useState<string | null>(null);
  const [followUpBanner, setFollowUpBanner] = useState<{ kind: "recurring"; taskId: string; schedule: string } | null>(null);
  const [creatingRecurring, setCreatingRecurring] = useState(false);
  const [artifactFollowUp, setArtifactFollowUp] = useState<{ format: ArtifactExportFormat; artifactId: string; artifactTitle: string } | null>(null);
  const [automations, setAutomations] = useState<Array<{
    id: string; title: string; reason: string; schedule: string; ownerSlot: string; estimatedCostCents: number;
  }>>([]);
  const [scanningAutomations, setScanningAutomations] = useState(false);
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
    setLoading(false);
  }, [companyId]);

  const scanAutomations = useCallback(async () => {
    setScanningAutomations(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/automations`, { method: "POST" });
      if (res.ok) {
        const data = await res.json() as { suggestions: typeof automations };
        setAutomations(data.suggestions ?? []);
      }
    } finally {
      setScanningAutomations(false);
    }
  }, [companyId]);

  async function respondToAutomation(id: string, action: "accept" | "snooze" | "reject") {
    setAutomations((prev) => prev.filter((a) => a.id !== id));
    await fetch(`/api/companies/${companyId}/automations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestionId: id, action }),
    });
  }

  useEffect(() => { load(); }, [load]);

  // Scroll to bottom when messages update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;

    // ── Follow-up: recurring task schedule ────────────────────────────────
    const recurringSchedule = mode === "org" ? detectRecurringFollowUp(text) : null;
    if (recurringSchedule && lastTaskId) {
      setFollowUpBanner({ kind: "recurring", taskId: lastTaskId, schedule: recurringSchedule });
      setInput("");
      return;
    }

    // ── Follow-up: artifact format conversion ─────────────────────────────
    const artifactFormat = mode === "org" ? detectArtifactFollowUp(text) : null;
    if (artifactFormat && artifacts.length > 0) {
      const latest = artifacts[0];
      setArtifactFollowUp({ format: artifactFormat, artifactId: latest.id, artifactTitle: latest.title });
      setInput("");
      return;
    }

    setSending(true);
    setStreamingReply(false);
    setInput("");

    // Optimistically add owner message
    const optimistic: CeoMessage = {
      id: `opt-${Date.now()}`,
      companyId,
      direction: "from_owner",
      kind: "chat",
      content: text,
      createdAt: new Date().toISOString()
    };
    setMessages((prev) => [...prev, optimistic]);
    // Show typing indicator after a short delay
    const streamTimer = setTimeout(() => setStreamingReply(true), 400);

    try {
      const res = await fetch("/api/ceo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, message: text, mode })
      });
      if (res.ok) {
        const data = await res.json() as {
          ceoMessage: CeoMessage;
          suggestions?: CeoSuggestion[];
          createdTasks?: Array<{ id: string }>;
          createdArtifacts?: Artifact[];
          understood?: { intent?: string; routedTo?: string; willDo?: string; approvalRequired?: boolean };
          mode?: CeoChatMode;
        };
        // Replace optimistic msg with real, add CEO reply
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimistic.id),
          data.ceoMessage
        ]);
        if (data.suggestions?.length) {
          setSuggestions((prev) => [...(data.suggestions ?? []), ...prev]);
        }
        if (data.understood) setLastUnderstood(data.understood);
        if (data.createdTasks?.length) {
          setLastCreatedCount(data.createdTasks.length);
          setLastTaskId(data.createdTasks[0]?.id ?? null);
        } else {
          setLastCreatedCount(0);
        }
        if (data.createdArtifacts?.length) {
          setArtifacts((prev) => [...(data.createdArtifacts ?? []), ...prev]);
          setLastCreatedArtifactCount(data.createdArtifacts.length);
        } else {
          setLastCreatedArtifactCount(0);
        }
      }
    } finally {
      clearTimeout(streamTimer);
      setStreamingReply(false);
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  async function dismissSuggestion(id: string, status: "done" | "dismissed") {
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
    await fetch("/api/ceo", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status })
    });
  }

  async function approveArtifact(id: string) {
    const res = await fetch(`/api/artifacts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved" })
    });
    if (!res.ok) return;
    const data = await res.json() as { artifact: Artifact };
    setArtifacts((prev) => prev.map((item) => item.id === id ? data.artifact : item));
    setSelectedArtifact(data.artifact);
  }

  function detectArtifactFollowUp(text: string): ArtifactExportFormat | null {
    const t = text.toLowerCase();
    if (/(make it|export|turn (this|that|it) into|give me|download|get).*(pdf|portable document)/i.test(t)) return "pdf";
    if (/(make it|export|turn (this|that|it) into|give me|download|get).*(xlsx|excel|spreadsheet)/i.test(t)) return "xlsx";
    if (/(make it|export|turn (this|that|it) into|give me|download|get).*(csv|comma.separated)/i.test(t)) return "csv";
    if (/(make it|export|turn (this|that|it) into|give me|download|get).*(html|web page)/i.test(t)) return "html";
    if (/(make it|export|turn (this|that|it) into|give me|download|get).*markdown/i.test(t)) return "markdown";
    // Standalone format requests when there's a recent artifact
    if (/^(pdf|xlsx|csv|html|markdown)(\s+(please|format|version))?$/i.test(text.trim())) {
      const fmt = text.trim().toLowerCase().split(/\s/)[0] as ArtifactExportFormat;
      if (["pdf","xlsx","csv","html","markdown"].includes(fmt)) return fmt;
    }
    return null;
  }

  function detectRecurringFollowUp(text: string): string | null {
    const t = text.toLowerCase();
    if (/(run|do|schedule|repeat|run this|do this).*(every|each)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(text)) {
      const day = text.match(/monday|tuesday|wednesday|thursday|friday|saturday|sunday/i)?.[0] ?? "monday";
      return `weekly:${day.toLowerCase()}`;
    }
    if (/(run|schedule|repeat|do).*(every|each)?\s*week(ly)?/i.test(t) || /weekly/i.test(t)) return "weekly";
    if (/(run|schedule|repeat|do).*(every|each)?\s*day(ly)?/i.test(t) || /daily/i.test(t)) return "daily";
    if (/(turn|make|convert)\s+(this|it).*(recurring|repeating|scheduled|automatic)/i.test(t)) return "weekly";
    return null;
  }

  async function createRecurringFromTask(taskId: string, schedule: string) {
    setCreatingRecurring(true);
    try {
      const res = await fetch(`/api/recurring-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, fromTaskId: taskId, schedule: schedule.startsWith("weekly") ? "weekly" : "daily" }),
      });
      if (res.ok) {
        setFollowUpBanner(null);
        // Surface confirmation as a system message
        const confirmMsg: CeoMessage = {
          id: `local-${Date.now()}`,
          companyId,
          direction: "from_ceo",
          kind: "chat",
          content: `Done — I've set up a recurring ${schedule.startsWith("weekly") ? "weekly" : "daily"} run for that task. I'll automatically create a new instance when it's due.`,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, confirmMsg]);
      }
    } finally {
      setCreatingRecurring(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 400 }}>
        <div className="spinner" style={{ width: 22, height: 22, borderWidth: 2 }} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
        <div>
          <div className="mono" style={{ fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--pulse)", marginBottom: 8 }}>
            command
          </div>
          <h1 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 26, letterSpacing: "-.02em", color: "var(--bone)", margin: "0 0 8px" }}>
            Talk to Your CEO
          </h1>
          <p style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.6, maxWidth: "56ch", margin: 0 }}>
            {mode === "org"
              ? "Ask about this company, uploaded memory, agent work, reports, priorities, blockers, and approvals."
              : "Ask general questions through the model bridge: code, science, politics, writing, strategy, and more."}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <CommandChatModeToggle
            mode={mode}
            onModeChange={(nextMode) => {
              setMode(nextMode);
              setLastUnderstood(null);
            }}
          />

        {/* Autopilot toggle */}
        <button
          onClick={() => setAutopilotOn((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            borderRadius: 8,
            background: autopilotOn ? "rgba(110,231,183,.08)" : "var(--ink)",
            border: autopilotOn ? "1px solid rgba(110,231,183,.25)" : "1px solid rgba(255,255,255,.08)",
            color: autopilotOn ? "var(--pulse)" : "var(--haze)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: ".12em",
            textTransform: "uppercase",
            cursor: "pointer",
            flexShrink: 0,
            transition: "all .2s",
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: autopilotOn ? "var(--pulse)" : "var(--haze)",
              boxShadow: autopilotOn ? "0 0 6px var(--pulse)" : "none",
              transition: "all .3s",
            }}
          />
          {autopilotOn ? "autopilot on" : "autopilot off"}
        </button>
        <button
          onClick={scanAutomations}
          disabled={scanningAutomations}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            borderRadius: 8,
            background: "var(--ink)",
            border: "1px solid rgba(255,255,255,.08)",
            color: "var(--haze)",
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: ".12em",
            textTransform: "uppercase",
            cursor: "pointer",
            flexShrink: 0,
            transition: "all .2s",
          }}
        >
          {scanningAutomations ? (
            <div className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
          ) : (
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(99,102,241,.6)" }} />
          )}
          {scanningAutomations ? "scanning…" : "automate"}
        </button>
        </div>
      </div>

      {/* ── What Trent understood ─────────────────────────────────────────── */}
      {lastUnderstood && (lastUnderstood.intent || lastUnderstood.willDo) && (
        <div
          style={{
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(110,231,183,.04)",
            border: "1px solid rgba(110,231,183,.18)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 14,
            animation: "enter-up .25s var(--ease-out-expo) both",
          }}
        >
          {lastUnderstood.intent && (
            <div>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 4 }}>understood</div>
              <div style={{ fontSize: 12, color: "var(--bone-2)", lineHeight: 1.4 }}>{lastUnderstood.intent}</div>
            </div>
          )}
          {lastUnderstood.routedTo && (
            <div>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 4 }}>routed to</div>
              <div style={{ fontSize: 12, color: "var(--pulse)", fontFamily: "var(--mono)", letterSpacing: ".06em" }}>{lastUnderstood.routedTo}</div>
            </div>
          )}
          {lastUnderstood.willDo && (
            <div>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 4 }}>will do</div>
              <div style={{ fontSize: 12, color: "var(--bone-2)", lineHeight: 1.4 }}>{lastUnderstood.willDo}</div>
            </div>
          )}
          {lastCreatedCount > 0 && (
            <div>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 4 }}>created</div>
              <div style={{ fontSize: 12, color: "var(--pulse)" }}>
                {lastCreatedCount} task{lastCreatedCount !== 1 ? "s" : ""} queued
                {lastUnderstood.approvalRequired && <span style={{ color: "var(--ember)", marginLeft: 8 }}>· approval required</span>}
              </div>
            </div>
          )}
          {lastCreatedArtifactCount > 0 && (
            <div>
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 4 }}>artifact</div>
              <div style={{ fontSize: 12, color: "var(--pulse)" }}>
                {lastCreatedArtifactCount} artifact{lastCreatedArtifactCount !== 1 ? "s" : ""} built
              </div>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "flex-end" }}>
            <button
              onClick={() => { setLastUnderstood(null); setLastCreatedCount(0); setLastCreatedArtifactCount(0); }}
              style={{ background: "transparent", border: 0, color: "var(--haze)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}
            >×</button>
          </div>
        </div>
      )}

      {artifacts.length > 0 && (
        <ArtifactShelf
          artifacts={artifacts}
          onOpen={setSelectedArtifact}
        />
      )}

      {/* ── Proactive Automations (Heartbeat) ────────────────────────────── */}
      {automations.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--pulse)" }}>
              trent noticed · {automations.length} automation idea{automations.length !== 1 ? "s" : ""}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {automations.map((a) => (
              <div
                key={a.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: 14,
                  padding: "14px 16px",
                  borderRadius: 12,
                  background: "rgba(99,102,241,.05)",
                  border: "1px solid rgba(99,102,241,.2)",
                  animation: "enter-up .2s var(--ease-out-expo) both",
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--bone)", marginBottom: 4 }}>{a.title}</div>
                  <div style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.5, marginBottom: 6 }}>{a.reason}</div>
                  <div className="mono" style={{ fontSize: 9, letterSpacing: ".14em", color: "var(--haze)" }}>
                    {a.schedule} · {a.ownerSlot} · {a.estimatedCostCents > 0 ? `~$${(a.estimatedCostCents / 100).toFixed(2)}/run` : "free"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                  <button
                    onClick={() => respondToAutomation(a.id, "accept")}
                    style={{ height: 28, padding: "0 12px", borderRadius: 6, background: "rgba(110,231,183,.1)", border: "1px solid rgba(110,231,183,.25)", color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".1em", cursor: "pointer" }}
                  >own it</button>
                  <button
                    onClick={() => respondToAutomation(a.id, "snooze")}
                    style={{ height: 28, padding: "0 10px", borderRadius: 6, background: "transparent", border: "1px solid rgba(255,255,255,.08)", color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 10, cursor: "pointer" }}
                  >later</button>
                  <button
                    onClick={() => respondToAutomation(a.id, "reject")}
                    style={{ height: 28, width: 28, borderRadius: 6, background: "transparent", border: "1px solid rgba(255,255,255,.06)", color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 14, cursor: "pointer" }}
                  >×</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Suggestions ────────────────────────────────────────────────────── */}
      {suggestions.length > 0 && (
        <div>
          <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 12 }}>
            ceo suggests · {suggestions.length} action{suggestions.length !== 1 ? "s" : ""} for you
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {suggestions.map((s) => {
              const cat = SUGGESTION_CATEGORY[s.category];
              return (
                <div
                  key={s.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 14,
                    padding: "14px 16px",
                    borderRadius: 12,
                    background: `${cat.color}07`,
                    border: `1px solid ${cat.color}20`,
                    animation: "enter-up .2s var(--ease-out-expo) both",
                  }}
                >
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 9,
                      background: `${cat.color}14`,
                      border: `1px solid ${cat.color}28`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 15,
                      flexShrink: 0,
                    }}
                  >
                    {cat.emoji}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--bone)" }}>{s.title}</span>
                      <span
                        className="mono"
                        style={{ fontSize: 8, letterSpacing: ".14em", textTransform: "uppercase", color: cat.color }}
                      >
                        {cat.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.55 }}>{s.body}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0, marginTop: 2 }}>
                    <button
                      onClick={() => dismissSuggestion(s.id, "done")}
                      style={{
                        padding: "4px 10px",
                        borderRadius: 6,
                        background: `${cat.color}12`,
                        border: `1px solid ${cat.color}28`,
                        color: cat.color,
                        fontSize: 10,
                        fontFamily: "var(--mono)",
                        letterSpacing: ".1em",
                        cursor: "pointer",
                      }}
                    >
                      done
                    </button>
                    <button
                      onClick={() => dismissSuggestion(s.id, "dismissed")}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 6,
                        background: "transparent",
                        border: "1px solid rgba(255,255,255,.06)",
                        color: "var(--haze)",
                        fontSize: 10,
                        fontFamily: "var(--mono)",
                        cursor: "pointer",
                      }}
                    >
                      <I.x style={{ width: 10, height: 10 }} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Follow-up banner ─────────────────────────────────────────────── */}
      {followUpBanner && (
        <div
          style={{
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(110,231,183,.04)",
            border: "1px solid rgba(110,231,183,.2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            animation: "enter-up .25s var(--ease-out-expo) both",
          }}
        >
          <div>
            <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--pulse)", marginBottom: 4 }}>
              follow-up detected
            </div>
            <div style={{ fontSize: 13, color: "var(--bone)" }}>
              Turn this into a <strong>{followUpBanner.schedule.startsWith("weekly") ? "weekly" : "daily"}</strong> recurring task?
              {followUpBanner.schedule.includes(":") && ` Runs every ${followUpBanner.schedule.split(":")[1]}.`}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => createRecurringFromTask(followUpBanner.taskId, followUpBanner.schedule)}
              disabled={creatingRecurring}
              style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid rgba(110,231,183,.3)", background: "rgba(110,231,183,.08)", color: "var(--pulse)", fontSize: 11, fontFamily: "var(--mono)", letterSpacing: ".1em", cursor: "pointer" }}
            >
              {creatingRecurring ? "creating…" : "yes, schedule it"}
            </button>
            <button
              onClick={() => setFollowUpBanner(null)}
              style={{ padding: "7px 12px", borderRadius: 7, border: "1px solid rgba(255,255,255,.08)", background: "transparent", color: "var(--haze)", fontSize: 11, fontFamily: "var(--mono)", cursor: "pointer" }}
            >
              dismiss
            </button>
          </div>
        </div>
      )}

      {/* ── Artifact format follow-up banner ──────────────────────────────── */}
      {artifactFollowUp && (
        <div
          style={{
            padding: "14px 18px",
            borderRadius: 12,
            background: "rgba(99,102,241,.05)",
            border: "1px solid rgba(99,102,241,.22)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            animation: "enter-up .25s var(--ease-out-expo) both",
          }}
        >
          <div>
            <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "#A5B4FC", marginBottom: 4 }}>
              export detected
            </div>
            <div style={{ fontSize: 13, color: "var(--bone)" }}>
              Download <strong>{artifactFollowUp.artifactTitle}</strong> as <strong>{artifactFollowUp.format.toUpperCase()}</strong>?
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <a
              href={`/api/artifacts/${artifactFollowUp.artifactId}/download?format=${artifactFollowUp.format}`}
              onClick={() => setArtifactFollowUp(null)}
              style={{
                height: 30,
                padding: "0 14px",
                borderRadius: 7,
                border: "1px solid rgba(99,102,241,.3)",
                background: "rgba(99,102,241,.1)",
                color: "#A5B4FC",
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: ".1em",
                display: "inline-flex",
                alignItems: "center",
                textDecoration: "none",
              }}
            >
              download {artifactFollowUp.format}
            </a>
            <button
              onClick={() => setArtifactFollowUp(null)}
              style={{ height: 30, padding: "0 12px", borderRadius: 7, border: "1px solid rgba(255,255,255,.08)", background: "transparent", color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 10, cursor: "pointer" }}
            >
              dismiss
            </button>
          </div>
        </div>
      )}

      {/* ── Chat pane ──────────────────────────────────────────────────────── */}
      <div
        style={{
          background: "var(--ink)",
          border: "1px solid rgba(255,255,255,.07)",
          borderRadius: "var(--r-md)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minHeight: 480,
        }}
      >
        {/* Messages */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 0,
            maxHeight: 520,
          }}
        >
          {messages.length === 0 ? (
            <EmptyState mode={mode} />
          ) : (
            <MessageList messages={messages} />
          )}
          {/* Typing / streaming indicator */}
          {streamingReply && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14 }}>
              <div style={{ width: 26, height: 26, borderRadius: 8, background: "rgba(110,231,183,.12)", border: "1px solid rgba(110,231,183,.22)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>🏛</div>
              <div style={{ padding: "10px 14px", borderRadius: "4px 14px 14px 14px", background: "var(--steel)", border: "1px solid rgba(255,255,255,.07)", display: "flex", gap: 5, alignItems: "center" }}>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--pulse)", animation: `pulse-dot 1.2s ${i * 0.2}s infinite` }}
                  />
                ))}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: "rgba(255,255,255,.05)" }} />

        {/* Input */}
        <div style={{ padding: "14px 20px", display: "flex", gap: 10, alignItems: "flex-end" }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            rows={1}
            placeholder={mode === "org"
              ? "Ask about this company, memory, reports, tasks, approvals..."
              : "Ask a general question, like ChatGPT..."}
            className="input"
            style={{
              flex: 1,
              resize: "none",
              minHeight: 38,
              maxHeight: 120,
              lineHeight: 1.5,
              fontSize: 13,
              overflowY: "auto",
            }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || sending}
            style={{
              height: 38,
              minWidth: 38,
              borderRadius: 9,
              background: input.trim() && !sending ? "var(--pulse)" : "rgba(110,231,183,.12)",
              border: "none",
              color: input.trim() && !sending ? "#0A0A0F" : "var(--haze)",
              cursor: input.trim() && !sending ? "pointer" : "not-allowed",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all .15s",
              flexShrink: 0,
            }}
          >
            {sending ? (
              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2, borderColor: "var(--haze)", borderTopColor: "transparent" }} />
            ) : (
              <I.play style={{ width: 14, height: 14 }} />
            )}
          </button>
        </div>

          <div className="mono" style={{ fontSize: 9, letterSpacing: ".12em", color: "var(--haze)", padding: "0 20px 10px", opacity: 0.6 }}>
          {mode === "org"
            ? "Enter to send · Shift+Enter for newline · Org mode can create reports, dashboards, PDFs, spreadsheets, and tasks"
            : "Enter to send · Shift+Enter for newline · Gen mode answers directly and does not create company work"}
        </div>
      </div>

      {selectedArtifact && (
        <ArtifactDrawer
          artifact={selectedArtifact}
          companyId={companyId}
          onClose={() => setSelectedArtifact(null)}
          onApprove={approveArtifact}
          onRegenerate={async () => {
            // Ask CEO to regenerate this artifact
            const res = await fetch("/api/ceo", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ companyId, message: `Regenerate the artifact: ${selectedArtifact?.title}` })
            });
            if (res.ok) {
              const data = await res.json() as { createdArtifacts?: Artifact[] };
              if (data.createdArtifacts?.length) {
                setArtifacts((prev) => [...(data.createdArtifacts ?? []), ...prev]);
              }
            }
          }}
        />
      )}
    </div>
  );
}

// ── Artifacts ────────────────────────────────────────────────────────────────

const ARTIFACT_LABEL: Record<Artifact["type"], string> = {
  board_pdf: "Board PDF",
  xlsx_report: "XLSX Report",
  dashboard: "Dashboard",
  investor_update: "Investor Update",
  campaign_report: "Campaign Report",
  competitive_research: "Competitive Research",
  operating_memo: "Operating Memo",
  support_summary: "Support Summary",
};

const ARTIFACT_TONE: Record<Artifact["status"], { bg: string; border: string; color: string }> = {
  draft: { bg: "rgba(255,255,255,.03)", border: "rgba(255,255,255,.08)", color: "var(--haze)" },
  ready: { bg: "rgba(110,231,183,.06)", border: "rgba(110,231,183,.2)", color: "var(--pulse)" },
  needs_approval: { bg: "rgba(249,115,22,.07)", border: "rgba(249,115,22,.25)", color: "var(--ember)" },
  approved: { bg: "rgba(110,231,183,.08)", border: "rgba(110,231,183,.28)", color: "var(--pulse)" },
  sent: { bg: "rgba(99,102,241,.08)", border: "rgba(99,102,241,.25)", color: "#A5B4FC" },
  failed: { bg: "rgba(248,113,113,.08)", border: "rgba(248,113,113,.25)", color: "#FCA5A5" },
};

function ArtifactShelf({ artifacts, onOpen }: { artifacts: Artifact[]; onOpen: (artifact: Artifact) => void }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--haze)" }}>
          artifacts · {artifacts.length} built
        </div>
        <a
          href={`/api/artifacts?companyId=${artifacts[0]?.companyId ?? ""}`}
          className="mono"
          style={{ fontSize: 9, letterSpacing: ".12em", color: "var(--haze)", textDecoration: "none" }}
        >
          api
        </a>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        {artifacts.slice(0, 6).map((artifact) => {
          const tone = ARTIFACT_TONE[artifact.status];
          return (
            <button
              key={artifact.id}
              onClick={() => onOpen(artifact)}
              style={{
                textAlign: "left",
                padding: "14px 15px",
                borderRadius: 12,
                background: "var(--ink)",
                border: "1px solid rgba(255,255,255,.07)",
                cursor: "pointer",
                minHeight: 124,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
                <span className="mono" style={{ fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--pulse)" }}>
                  {ARTIFACT_LABEL[artifact.type]}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 8,
                    letterSpacing: ".1em",
                    textTransform: "uppercase",
                    padding: "4px 7px",
                    borderRadius: 999,
                    background: tone.bg,
                    border: `1px solid ${tone.border}`,
                    color: tone.color,
                    flexShrink: 0,
                  }}
                >
                  {artifact.status.replace("_", " ")}
                </span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 650, color: "var(--bone)", lineHeight: 1.3, marginBottom: 7 }}>
                {artifact.title}
              </div>
              <div style={{ fontSize: 11, color: "var(--mist)", lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {artifact.summary}
              </div>
              <div className="mono" style={{ fontSize: 8, letterSpacing: ".12em", color: "var(--haze)", marginTop: 12, textTransform: "uppercase" }}>
                {artifact.exportFormat} · {artifact.createdByAgent}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ArtifactDrawer({
  artifact,
  companyId,
  onClose,
  onApprove,
  onRegenerate,
}: {
  artifact: Artifact;
  companyId: string;
  onClose: () => void;
  onApprove: (id: string) => void;
  onRegenerate?: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  function handleShare() {
    const url = `${window.location.origin}/companies/${companyId}/artifacts`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleRegenerate() {
    if (!onRegenerate) return;
    setRegenerating(true);
    try { await onRegenerate(); } finally { setRegenerating(false); }
  }

  const formats: Array<{ key: string; label: string }> = [
    { key: "markdown", label: "Markdown" },
    { key: "pdf", label: "PDF" },
    { key: "html", label: "HTML" },
    { key: "csv", label: "CSV" },
    { key: "xlsx", label: "XLSX" },
    { key: "dashboard_json", label: "JSON" },
  ];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(0,0,0,.48)",
        display: "flex",
        justifyContent: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100vw)",
          height: "100%",
          background: "var(--night)",
          borderLeft: "1px solid rgba(255,255,255,.1)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "-24px 0 70px rgba(0,0,0,.35)",
        }}
      >
        <div style={{ padding: "22px 24px", borderBottom: "1px solid rgba(255,255,255,.07)", display: "flex", alignItems: "flex-start", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--pulse)", marginBottom: 8 }}>
              {ARTIFACT_LABEL[artifact.type]}
            </div>
            <h2 style={{ margin: 0, color: "var(--bone)", fontFamily: "var(--display)", fontSize: 22, letterSpacing: "-.01em" }}>
              {artifact.title}
            </h2>
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--mist)", lineHeight: 1.55 }}>
              {artifact.summary}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{ width: 32, height: 32, borderRadius: 8, border: "1px solid rgba(255,255,255,.08)", background: "transparent", color: "var(--haze)", cursor: "pointer" }}
          >
            <I.x style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <div style={{ padding: "14px 24px", borderBottom: "1px solid rgba(255,255,255,.06)", display: "flex", flexWrap: "wrap", gap: 8 }}>
          {formats.map((format) => (
            <a
              key={format.key}
              href={`/api/artifacts/${artifact.id}/download?format=${format.key}`}
              style={{
                height: 30,
                padding: "0 11px",
                borderRadius: 7,
                border: "1px solid rgba(255,255,255,.08)",
                background: format.key === artifact.exportFormat ? "rgba(110,231,183,.08)" : "var(--ink)",
                color: format.key === artifact.exportFormat ? "var(--pulse)" : "var(--mist)",
                display: "inline-flex",
                alignItems: "center",
                textDecoration: "none",
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
              }}
            >
              {format.label}
            </a>
          ))}
          {artifact.status === "needs_approval" && (
            <button
              onClick={() => onApprove(artifact.id)}
              style={{
                height: 30,
                padding: "0 12px",
                borderRadius: 7,
                border: "1px solid rgba(110,231,183,.25)",
                background: "rgba(110,231,183,.1)",
                color: "var(--pulse)",
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              approve
            </button>
          )}
          {/* Spacer */}
          <div style={{ flex: 1 }} />
          {/* Share */}
          <button
            onClick={handleShare}
            style={{
              height: 30,
              padding: "0 11px",
              borderRadius: 7,
              border: "1px solid rgba(255,255,255,.08)",
              background: copied ? "rgba(110,231,183,.08)" : "var(--ink)",
              color: copied ? "var(--pulse)" : "var(--mist)",
              fontFamily: "var(--mono)",
              fontSize: 10,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              cursor: "pointer",
              transition: "all .2s",
            }}
          >
            {copied ? "copied!" : "share"}
          </button>
          {/* Regenerate */}
          {onRegenerate && (
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              style={{
                height: 30,
                padding: "0 11px",
                borderRadius: 7,
                border: "1px solid rgba(255,255,255,.08)",
                background: "var(--ink)",
                color: "var(--mist)",
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {regenerating ? (
                <><span className="spinner" style={{ width: 8, height: 8, borderWidth: 1.5, borderColor: "var(--haze)", borderTopColor: "transparent" }} /> regenerating…</>
              ) : "regenerate"}
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "24px" }}>
          <CodeBlock block={{ content: artifact.content, language: "markdown", filename: artifact.title }} />
        </div>

        <div style={{ padding: "14px 24px", borderTop: "1px solid rgba(255,255,255,.07)" }}>
          <div className="mono" style={{ fontSize: 9, letterSpacing: ".12em", color: "var(--haze)", lineHeight: 1.7 }}>
            provenance · {artifact.provenance.model} · {artifact.provenance.sources.length} sources · external sends disabled
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Message list ──────────────────────────────────────────────────────────────

function MessageList({ messages }: { messages: CeoMessage[] }) {
  // Group consecutive messages by direction for visual batching
  const groups: Array<{ direction: CeoMessage["direction"]; items: CeoMessage[] }> = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && last.direction === m.direction) {
      last.items.push(m);
    } else {
      groups.push({ direction: m.direction, items: [m] });
    }
  }

  // Build date separators
  const withDates: Array<{ type: "date"; label: string } | { type: "group"; direction: CeoMessage["direction"]; items: CeoMessage[] }> = [];
  let lastDate = "";
  for (const g of groups) {
    const d = fmtDate(g.items[0].createdAt);
    if (d !== lastDate) {
      withDates.push({ type: "date", label: d });
      lastDate = d;
    }
    withDates.push({ type: "group", ...g });
  }

  return (
    <>
      {withDates.map((entry, i) => {
        if (entry.type === "date") {
          return (
            <div
              key={`date-${i}`}
              style={{ display: "flex", alignItems: "center", gap: 12, margin: "16px 0 10px" }}
            >
              <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.05)" }} />
              <span className="mono" style={{ fontSize: 8, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--haze)" }}>
                {entry.label}
              </span>
              <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.05)" }} />
            </div>
          );
        }

        const isCeo = entry.direction === "from_ceo";
        return (
          <div
            key={`group-${i}`}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: isCeo ? "flex-start" : "flex-end",
              gap: 3,
              marginBottom: 14,
            }}
          >
            {/* Sender label */}
            <div className="mono" style={{ fontSize: 8, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--haze)", padding: isCeo ? "0 2px 0 0" : "0 2px", marginBottom: 2 }}>
              {isCeo ? "ceo" : "you"}
            </div>

            {entry.items.map((m, mi) => (
              <div key={m.id} style={{ display: "flex", alignItems: "flex-end", gap: 8, maxWidth: "78%" }}>
                {/* CEO avatar on first bubble */}
                {isCeo && mi === 0 && (
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      background: "rgba(110,231,183,.12)",
                      border: "1px solid rgba(110,231,183,.22)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 13,
                      flexShrink: 0,
                      marginBottom: 2,
                    }}
                  >
                    🏛
                  </div>
                )}
                {isCeo && mi > 0 && <div style={{ width: 26, flexShrink: 0 }} />}

                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: isCeo
                        ? mi === 0 ? "4px 14px 14px 14px" : "4px 14px 14px 4px"
                        : mi === 0 ? "14px 4px 14px 14px" : "14px 4px 4px 14px",
                      background: isCeo
                        ? m.kind === "autopilot_update"
                          ? "rgba(110,231,183,.06)"
                          : "var(--steel)"
                        : "rgba(110,231,183,.1)",
                      border: isCeo
                        ? m.kind === "autopilot_update"
                          ? "1px solid rgba(110,231,183,.15)"
                          : "1px solid rgba(255,255,255,.07)"
                        : "1px solid rgba(110,231,183,.25)",
                      fontSize: 13,
                      color: isCeo ? "var(--bone)" : "var(--bone)",
                      lineHeight: 1.55,
                      wordBreak: "break-word",
                    }}
                  >
                    {m.kind === "autopilot_update" && (
                      <span className="mono" style={{ fontSize: 8, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--pulse)", display: "block", marginBottom: 5 }}>
                        ◈ autopilot update
                      </span>
                    )}
                    <NarrationText text={m.content} />
                  </div>
                  {/* Timestamp on last bubble of group */}
                  {mi === entry.items.length - 1 && (
                    <div
                      className="mono"
                      style={{
                        fontSize: 8,
                        letterSpacing: ".1em",
                        color: "var(--haze)",
                        padding: "0 3px",
                        textAlign: isCeo ? "left" : "right",
                      }}
                    >
                      {fmtTime(m.createdAt)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ mode }: { mode: CeoChatMode }) {
  const prompts = mode === "org"
    ? [
        "What's running right now?",
        "What needs my approval?",
        "What does our uploaded memory say about our ICP?",
        "Create an investor update I can review.",
      ]
    : [
        "Explain this code error.",
        "What are the tradeoffs in this strategy?",
        "Give me a simple explanation of quantum entanglement.",
        "Draft a concise email.",
      ];

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: "48px 20px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 16,
          background: "rgba(110,231,183,.08)",
          border: "1px solid rgba(110,231,183,.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 24,
        }}
      >
        🏛
      </div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--bone)", marginBottom: 6 }}>
          {mode === "org" ? "Your CEO is ready" : "General chat is ready"}
        </div>
        <div style={{ fontSize: 12, color: "var(--haze)", lineHeight: 1.6, maxWidth: "36ch" }}>
          {mode === "org"
            ? "Ask for company status, priorities, memory, reports, or approval blockers."
            : "Ask broad questions without creating tasks, artifacts, or company side effects."}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 340 }}>
        {prompts.map((q) => (
          <div
            key={q}
            style={{
              padding: "8px 14px",
              borderRadius: 9,
              background: "rgba(255,255,255,.02)",
              border: "1px solid rgba(255,255,255,.06)",
              fontSize: 12,
              color: "var(--mist)",
              cursor: "default",
            }}
          >
            {q}
          </div>
        ))}
      </div>
    </div>
  );
}
