"use client";

import { useState } from "react";
import { NarrationText } from "@/components/agent-activity";
import { I, Spinner } from "@/components/ui";

type AgentMode = "build" | "research" | "design";
type SessionStatus = "queued" | "starting" | "running" | "paused" | "completed" | "failed" | "cancelled";

export function WorkbenchNewSession({
  mode,
  creating,
  llmConfigured,
  onCreate,
}: {
  mode: AgentMode;
  creating: boolean;
  llmConfigured: boolean;
  onCreate: (objective: string, mode: AgentMode) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const submit = async () => {
    if (!value.trim() || !llmConfigured) return;
    const ok = await onCreate(value.trim(), mode);
    if (ok) setValue("");
  };
  return (
    <div style={S.newSessionWrap}>
      {!llmConfigured && (
        <div style={{ padding: "0 14px 8px" }}>
          <LlmNotConfiguredInline />
        </div>
      )}
      <div style={S.newSession}>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim() && llmConfigured) void submit();
          }}
          placeholder={llmConfigured ? `New ${mode} objective...` : "Configure OPENAI_API_KEY to add objectives"}
          style={S.newInput}
          disabled={creating || !llmConfigured}
        />
        <button
          onClick={() => void submit()}
          disabled={creating || !value.trim() || !llmConfigured}
          style={S.newBtn(creating || !value.trim() || !llmConfigured)}
          title="Start a new Workbench objective"
        >
          {creating ? <Spinner /> : <I.plus />}
        </button>
      </div>
    </div>
  );
}

function LlmNotConfiguredInline() {
  return (
    <p style={{ margin: 0, fontSize: 12, color: "var(--ember)", lineHeight: 1.45 }}>
      LLM not configured — see docs/RUN.md
    </p>
  );
}

export function WorkbenchBubble({ role, content, streaming }: { role: string; content: string; streaming?: boolean }) {
  const isUser = role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 12 }}>
      <div style={S.bubble(isUser)}>
        {!isUser && <span className="mono" style={S.bubbleRole}>trent{streaming ? " · streaming" : ""}</span>}
        <NarrationText text={content} live={streaming} />
      </div>
    </div>
  );
}

export function WorkbenchStatusDot({ status }: { status: SessionStatus }) {
  const color = status === "running" || status === "starting" ? "var(--pulse)"
    : status === "failed" || status === "cancelled" ? "var(--ember)"
    : status === "completed" ? "var(--pulse-deep)" : "var(--haze)";
  return <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />;
}

const border = "1px solid rgba(255,255,255,.07)";
const surface = "rgba(255,255,255,.02)";

const S = {
  newSessionWrap: { borderBottom: border } as React.CSSProperties,
  newSession: { display: "flex", gap: 6, padding: "12px 14px" } as React.CSSProperties,
  newInput: { flex: 1, background: surface, border, borderRadius: 7, padding: "8px 10px", color: "var(--bone)", fontSize: 13, outline: "none" } as React.CSSProperties,
  newBtn: (disabled: boolean) => ({
    width: 34, display: "grid", placeItems: "center",
    background: disabled ? "rgba(255,255,255,.06)" : "var(--pulse)",
    color: disabled ? "var(--haze)" : "#04140d",
    border: "none", borderRadius: 7,
    cursor: disabled ? "not-allowed" : "pointer",
  }) as React.CSSProperties,
  bubble: (isUser: boolean) => ({
    maxWidth: "78%", padding: "12px 14px", borderRadius: 12, fontSize: 14,
    background: isUser ? "rgba(110,231,183,.1)" : surface,
    border: isUser ? "1px solid rgba(110,231,183,.2)" : border,
  }) as React.CSSProperties,
  bubbleRole: { display: "block", fontSize: 10, letterSpacing: ".1em", color: "var(--haze)", marginBottom: 6 } as React.CSSProperties,
};
