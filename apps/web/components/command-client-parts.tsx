import React from "react";
import { AgentActivityFeed, CodeBlock, NarrationText, type ActivityStep } from "@/components/agent-activity";
import type { Artifact, CeoMessage, CeoSuggestion } from "@/lib/types";
import { I } from "@/components/ui";

export type ModelKey = "claude-sonnet-4-5" | "gpt-5.2" | "gemini-3-pro" | "claude-opus-4-7" | "gpt-5.4";
export type RunMode = "ask" | "agent" | "autonomous";

export const MODEL_OPTIONS: Array<{ key: ModelKey; label: string; tag: string; tone: string }> = [
  { key: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", tag: "best for agents",  tone: "#C0915A" },
  { key: "claude-opus-4-7",   label: "Claude Opus 4.7",   tag: "deep reasoning",   tone: "#D4A574" },
  { key: "gpt-5.2",           label: "GPT-5.2",           tag: "fast planner",     tone: "#10A37F" },
  { key: "gpt-5.4",           label: "GPT-5.4",           tag: "newest openai",    tone: "#10A37F" },
  { key: "gemini-3-pro",      label: "Gemini 3 Pro",      tag: "research / long ctx", tone: "#4285F4" },
];

const STARTER_PROMPTS: Record<RunMode, Array<{ icon: string; title: string; body: string }>> = {
  ask: [
    { icon: "?", title: "Status check", body: "What's running across the company right now?" },
    { icon: "?", title: "Approvals queue", body: "Show me what needs my approval and why." },
    { icon: "?", title: "Memory recall", body: "What does our uploaded memory say about our ICP?" },
    { icon: "?", title: "Briefing", body: "Give me a 60-second briefing of the last 24 hours." },
  ],
  agent: [
    { icon: "*", title: "Draft investor update", body: "Draft the May investor update and surface it for review." },
    { icon: "*", title: "Churn deep-dive", body: "Analyze churn for last 90 days and recommend one fix." },
    { icon: "*", title: "GitHub triage", body: "Triage the open issues and propose the next 3 PRs." },
    { icon: "*", title: "Pricing experiment", body: "Design a pricing experiment with hypothesis & success metric." },
  ],
  autonomous: [
    { icon: ">", title: "Run the company today", body: "Run a full operating cycle and surface anything that needs me." },
    { icon: ">", title: "Find revenue", body: "Find the single highest-leverage revenue move and execute the first 3 steps." },
    { icon: ">", title: "Self-evaluate", body: "Audit your own outputs from the past week and propose improvements." },
    { icon: ">", title: "Heartbeat", body: "Run an overnight heartbeat: cycles, monitoring, briefing, and self-review." },
  ],
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fmtDateLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Still up?";
  if (h < 12) return "Good morning.";
  if (h < 17) return "Good afternoon.";
  if (h < 22) return "Good evening.";
  return "Late night, founder.";
}

export function ConversationsRail({ sessionsByDay, orchRuns, collapsed, onOpenTrace, onToggle, onNewChat }: {
  sessionsByDay: Array<[string, CeoMessage[]]>;
  orchRuns: Array<{ id: string; objective: string; status: string; startedAt: string }>;
  collapsed: boolean;
  onOpenTrace: (runId: string) => void;
  onToggle: () => void;
  onNewChat: () => void;
}) {
  if (collapsed) {
    return (
      <div style={{ borderRight: "1px solid rgba(255,255,255,.05)", padding: 8, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <button onClick={onToggle} style={{ background: "transparent", border: 0, color: "var(--haze)", cursor: "pointer", padding: 6 }}>
          <I.chevR />
        </button>
        <button onClick={onNewChat} title="New chat" style={{ width: 28, height: 28, borderRadius: 8, background: "rgba(110,231,183,.08)", border: "1px solid rgba(110,231,183,.2)", color: "var(--pulse)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
      </div>
    );
  }
  return (
    <aside style={{
      borderRight: "1px solid rgba(255,255,255,.05)",
      padding: "20px 12px 20px 4px",
      display: "flex", flexDirection: "column", gap: 14,
      overflowY: "auto",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px" }}>
        <span className="mono" style={{ fontSize: 9, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--haze)" }}>conversations</span>
        <button onClick={onToggle} style={{ background: "transparent", border: 0, color: "var(--haze)", cursor: "pointer", padding: 4 }}>
          <I.chevR style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>

      <button
        onClick={onNewChat}
        data-testid="new-chat-btn"
        style={{
          display: "flex", alignItems: "center", gap: 9, padding: "9px 12px",
          background: "rgba(110,231,183,.06)", border: "1px solid rgba(110,231,183,.18)",
          color: "var(--pulse)", borderRadius: 9, cursor: "pointer", fontSize: 12,
          fontFamily: "var(--mono)", letterSpacing: ".1em",
        }}
      >
        <span style={{ fontSize: 14 }}>+</span> new chat
      </button>

      {orchRuns.length > 0 && (
        <div>
          <div className="mono" style={{ fontSize: 8, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--haze)", padding: "0 8px 6px" }}>
            autonomous runs
          </div>
          {orchRuns.slice(0, 5).map((r) => (
            <button
              key={r.id}
              onClick={() => onOpenTrace(r.id)}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", borderRadius: 7, marginBottom: 2, background: "transparent", border: 0, cursor: "pointer" }}
            >
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".1em", color: r.status === "completed" ? "var(--pulse)" : r.status === "failed" ? "#FCA5A5" : "#A5B4FC" }}>{r.status}</div>
              <div style={{ fontSize: 11, color: "var(--bone-2)", lineHeight: 1.4, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.objective}</div>
            </button>
          ))}
        </div>
      )}

      {sessionsByDay.length > 0 && (
        <div>
          <div className="mono" style={{ fontSize: 8, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--haze)", padding: "0 8px 6px" }}>
            history
          </div>
          {sessionsByDay.slice(0, 8).map(([day, items]) => (
            <div key={day} style={{ padding: "6px 8px", borderRadius: 7, marginBottom: 2 }}>
              <div style={{ fontSize: 11, color: "var(--bone-2)" }}>{day}</div>
              <div className="mono" style={{ fontSize: 9, color: "var(--haze)", marginTop: 2 }}>{items.length} message{items.length !== 1 ? "s" : ""}</div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

export function TopToolbar({ mode, setMode, model, setModel, modelPickerOpen, setModelPickerOpen, selectedModel }: {
  mode: RunMode;
  setMode: (m: RunMode) => void;
  model: ModelKey;
  setModel: (m: ModelKey) => void;
  modelPickerOpen: boolean;
  setModelPickerOpen: (b: boolean) => void;
  selectedModel: typeof MODEL_OPTIONS[number];
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 24px", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
      <div data-testid="mode-toggle" style={{ display: "inline-flex", background: "var(--steel)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 999, padding: 3, gap: 2 }}>
        {(["ask", "agent", "autonomous"] as RunMode[]).map((m) => (
          <button
            key={m}
            data-testid={`mode-${m}`}
            onClick={() => setMode(m)}
            className="mono"
            style={{
              padding: "6px 12px", borderRadius: 999, border: 0,
              background: mode === m ? "rgba(110,231,183,.12)" : "transparent",
              color: mode === m ? "var(--pulse)" : "var(--mist)",
              fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
              cursor: "pointer", fontWeight: mode === m ? 600 : 400,
            }}
          >
            {m === "ask" ? "ask" : m === "agent" ? "agent" : "autonomous"}
          </button>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ position: "relative" }}>
        <button
          data-testid="model-picker-btn"
          onClick={() => setModelPickerOpen(!modelPickerOpen)}
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "7px 12px",
            background: "var(--steel)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 9,
            color: "var(--bone)", cursor: "pointer",
          }}
        >
          <div style={{ width: 9, height: 9, borderRadius: "50%", background: selectedModel.tone }} />
          <span style={{ fontSize: 12, fontWeight: 500 }}>{selectedModel.label}</span>
          <I.chevR style={{ transform: modelPickerOpen ? "rotate(90deg)" : "rotate(0deg)", color: "var(--haze)", transition: "transform .2s" }} />
        </button>
        {modelPickerOpen && (
          <div data-testid="model-picker" style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, width: 280,
            background: "var(--night)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10,
            boxShadow: "0 18px 48px rgba(0,0,0,.45)", zIndex: 50, padding: 6,
          }}>
            {MODEL_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                data-testid={`model-option-${opt.key}`}
                onClick={() => { setModel(opt.key); setModelPickerOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%",
                  padding: "10px 12px", borderRadius: 7,
                  background: model === opt.key ? "rgba(110,231,183,.06)" : "transparent",
                  border: 0, color: "var(--bone)", cursor: "pointer", textAlign: "left", marginBottom: 2,
                }}
              >
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: opt.tone, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{opt.label}</div>
                  <div className="mono" style={{ fontSize: 9, letterSpacing: ".1em", color: "var(--haze)", marginTop: 1 }}>{opt.tag}</div>
                </div>
                {model === opt.key && <span style={{ color: "var(--pulse)" }}>ok</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function BlankState({ mode, onPickPrompt, suggestions }: {
  mode: RunMode;
  onPickPrompt: (p: string) => void;
  suggestions: CeoSuggestion[];
}) {
  const prompts = STARTER_PROMPTS[mode];
  const sub = mode === "ask"
    ? "ask anything - no company side effects."
    : mode === "agent"
      ? "I'll route to the right specialist and surface drafts before sending."
      : "I'll plan a multi-step task graph, execute autonomously, and self-review.";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px 100px", textAlign: "center", maxWidth: 760, margin: "0 auto", width: "100%" }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, background: "linear-gradient(135deg, rgba(110,231,183,.16), rgba(110,231,183,.04))", border: "1px solid rgba(110,231,183,.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, marginBottom: 28 }}>T</div>
      <h1 style={{ margin: "0 0 14px", fontFamily: "var(--serif)", fontStyle: "italic", fontSize: "clamp(32px, 4vw, 48px)", lineHeight: 1.15, color: "var(--bone)", fontWeight: 400, letterSpacing: "-.015em" }}>{greeting()}</h1>
      <p style={{ margin: "0 0 40px", fontSize: 16, color: "var(--mist)", lineHeight: 1.55, maxWidth: 520 }}>{sub}</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, width: "100%", maxWidth: 620 }}>
        {prompts.map((p) => (
          <button
            key={p.title}
            data-testid={`starter-${p.title.replace(/\s+/g, "-").toLowerCase()}`}
            onClick={() => onPickPrompt(p.body)}
            style={{ textAlign: "left", padding: "14px 16px", borderRadius: 12, background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.06)", cursor: "pointer", transition: "all .15s" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ color: "var(--pulse)", fontSize: 14 }}>{p.icon}</span>
              <span style={{ fontSize: 13, color: "var(--bone)", fontWeight: 500 }}>{p.title}</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.5 }}>{p.body}</div>
          </button>
        ))}
      </div>
      {suggestions.length > 0 && (
        <div style={{ marginTop: 40, width: "100%", maxWidth: 620 }}>
          <div className="mono" style={{ fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--pulse)", marginBottom: 10, textAlign: "left" }}>
            trent suggests / {suggestions.length}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-start" }}>
            {suggestions.slice(0, 6).map((s) => (
              <button key={s.id} onClick={() => onPickPrompt(s.title)} style={{ padding: "6px 12px", borderRadius: 999, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", color: "var(--bone-2)", fontSize: 11, cursor: "pointer" }}>
                {s.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Transcript({ sessionsByDay, streaming, artifacts, onOpenArtifact, bottomRef, messageActivity = {}, liveMessageId = null }: {
  sessionsByDay: Array<[string, CeoMessage[]]>;
  streaming: boolean;
  artifacts: Artifact[];
  onOpenArtifact: (a: Artifact) => void;
  bottomRef: React.RefObject<HTMLDivElement | null>;
  messageActivity?: Record<string, ActivityStep[]>;
  liveMessageId?: string | null;
}) {
  return (
    <div style={{ flex: 1, maxWidth: 760, margin: "0 auto", width: "100%", padding: "24px 0 140px" }}>
      {sessionsByDay.map(([day, items]) => (
        <div key={day}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "20px 0 14px" }}>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.05)" }} />
            <span className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)" }}>{day}</span>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.05)" }} />
          </div>
          {items.map((m, idx) => (
            <MessageBubble
              key={m.id}
              message={m}
              prev={items[idx - 1]}
              activitySteps={messageActivity[m.id]}
              live={liveMessageId === m.id}
            />
          ))}
        </div>
      ))}
      {streaming && (
        <div data-testid="streaming-indicator" style={{ display: "flex", alignItems: "center", gap: 9, padding: "16px 0 8px" }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: "rgba(110,231,183,.12)", border: "1px solid rgba(110,231,183,.22)", display: "flex", alignItems: "center", justifyContent: "center" }}>T</div>
          <div style={{ display: "flex", gap: 5 }}>
            {[0, 1, 2].map((i) => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--pulse)", animation: `pulse-dot 1.2s ${i * 0.2}s infinite` }} />)}
          </div>
        </div>
      )}
      {artifacts.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 10 }}>artifacts in this session / {artifacts.length}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
            {artifacts.slice(0, 6).map((a) => (
              <button key={a.id} onClick={() => onOpenArtifact(a)} style={{ textAlign: "left", padding: "12px 14px", borderRadius: 10, background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.06)", cursor: "pointer" }}>
                <div className="mono" style={{ fontSize: 9, letterSpacing: ".14em", color: "var(--pulse)", textTransform: "uppercase", marginBottom: 5 }}>{a.type.replace("_", " ")}</div>
                <div style={{ fontSize: 13, color: "var(--bone)", fontWeight: 500, marginBottom: 4 }}>{a.title}</div>
                <div style={{ fontSize: 11, color: "var(--mist)", lineHeight: 1.45, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{a.summary}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({
  message,
  prev,
  activitySteps,
  live = false,
}: {
  message: CeoMessage;
  prev?: CeoMessage;
  activitySteps?: ActivityStep[];
  live?: boolean;
}) {
  const isOwner = message.direction === "from_owner";
  const sameSenderAsPrev = prev && prev.direction === message.direction;
  const showActivity = !isOwner && message.kind === "autopilot_update" && activitySteps && activitySteps.length > 0;
  return (
    <div style={{ display: "flex", gap: 12, padding: sameSenderAsPrev ? "4px 0" : "14px 0" }}>
      <div style={{ width: 30, flexShrink: 0 }}>
        {!sameSenderAsPrev && (
          <div style={{ width: 30, height: 30, borderRadius: 9, background: isOwner ? "rgba(255,255,255,.05)" : "rgba(110,231,183,.12)", border: isOwner ? "1px solid rgba(255,255,255,.08)" : "1px solid rgba(110,231,183,.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: isOwner ? "var(--bone-2)" : "var(--pulse)" }}>
            {isOwner ? "you" : "T"}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {!sameSenderAsPrev && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--bone)" }}>{isOwner ? "You" : "Trent"}</span>
            <span className="mono" style={{ fontSize: 9, color: "var(--haze)" }}>{fmtTime(message.createdAt)}</span>
            {message.kind === "autopilot_update" && (
              <span className="mono" style={{ fontSize: 8, letterSpacing: ".14em", textTransform: "uppercase", background: "rgba(110,231,183,.08)", color: "var(--pulse)", padding: "2px 7px", borderRadius: 5, border: "1px solid rgba(110,231,183,.2)" }}>autopilot</span>
            )}
          </div>
        )}
        {showActivity ? (
          <AgentActivityFeed
            steps={activitySteps}
            live={live}
            narration={message.content}
            aria-label="Orchestrator activity"
          />
        ) : (
          <NarrationText text={message.content} live={live && !isOwner} />
        )}
      </div>
    </div>
  );
}

export function Composer({ input, setInput, onSend, sending, mode, textareaRef, disabled = false }: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  mode: RunMode;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}) {
  const blocked = disabled || sending;
  return (
    <div style={{ position: "sticky", bottom: 0, padding: "0 24px 24px", background: "linear-gradient(180deg, transparent, var(--night) 24%)" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", background: "var(--ink)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 18, padding: 10, boxShadow: "0 -4px 24px rgba(0,0,0,.2)" }}>
        <textarea
          ref={textareaRef}
          data-testid="composer-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!blocked && input.trim()) onSend(); } }}
          rows={1}
          disabled={blocked}
          placeholder={
            disabled
              ? "Configure OPENAI_API_KEY — see docs/RUN.md"
              : mode === "ask"
                ? "Ask Trent anything... (Enter to send, Shift+Enter for newline)"
                : mode === "agent"
                  ? "Tell Trent what to do. Specialists will execute."
                  : "Give Trent an objective. It will plan a multi-step run autonomously."
          }
          style={{ width: "100%", padding: "8px 12px", background: "transparent", border: 0, outline: 0, resize: "none", color: blocked && disabled ? "var(--haze)" : "var(--bone)", fontSize: 14, fontFamily: "inherit", lineHeight: 1.55, minHeight: 36, maxHeight: 320, overflowY: "auto" }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 0" }}>
          <span className="mono" style={{ fontSize: 9, color: "var(--haze)", letterSpacing: ".1em", flex: 1 }}>
            {mode === "autonomous" ? "autonomous / creates a multi-step run" : mode === "agent" ? "agent / creates tasks and artifacts" : "ask / no side effects"}
          </span>
          <button data-testid="composer-send-btn" onClick={onSend} disabled={!input.trim() || blocked} style={{ width: 36, height: 36, borderRadius: 10, background: input.trim() && !blocked ? "var(--pulse)" : "rgba(110,231,183,.12)", color: input.trim() && !blocked ? "#0A0A0F" : "var(--haze)", border: 0, cursor: input.trim() && !blocked ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {sending ? <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2, borderColor: "var(--haze)", borderTopColor: "transparent" }} /> : "->"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ArtifactDrawer({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,.5)", display: "flex", justifyContent: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(720px, 100vw)", height: "100%", background: "var(--night)", borderLeft: "1px solid rgba(255,255,255,.1)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
          <div className="mono" style={{ fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--pulse)", marginBottom: 6 }}>{artifact.type.replace("_", " ")}</div>
          <h2 style={{ margin: 0, fontSize: 20, color: "var(--bone)" }}>{artifact.title}</h2>
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--mist)" }}>{artifact.summary}</p>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          <CodeBlock block={{ content: artifact.content, language: "markdown", filename: artifact.title }} />
        </div>
      </div>
    </div>
  );
}
