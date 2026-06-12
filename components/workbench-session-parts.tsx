"use client";

import { useRef, useState } from "react";
import { NarrationText } from "@/components/agent-activity";
import { I, Spinner } from "@/components/ui";

type AgentMode = "build" | "research" | "design";
type SessionStatus = "queued" | "starting" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type WorkbenchCreateSource = {
  files?: File[];
  repoUrl?: string;
};

export function WorkbenchNewSession({
  mode,
  creating,
  llmConfigured,
  onCreate,
  placeholder,
}: {
  mode: AgentMode;
  creating: boolean;
  llmConfigured: boolean;
  onCreate: (objective: string, mode: AgentMode, source?: WorkbenchCreateSource) => Promise<boolean>;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [sourceMode, setSourceMode] = useState<"blank" | "upload" | "github">("blank");
  const [files, setFiles] = useState<File[]>([]);
  const [repoUrl, setRepoUrl] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (!value.trim() || !llmConfigured) return;
    const source = sourceMode === "upload"
      ? { files }
      : sourceMode === "github"
        ? { repoUrl: repoUrl.trim() }
        : undefined;
    const ok = await onCreate(value.trim(), mode, source);
    if (ok) setValue("");
  };
  const sourceReady = sourceMode === "blank"
    || (sourceMode === "upload" && files.length > 0)
    || (sourceMode === "github" && repoUrl.trim().length > 0);
  const disabled = creating || !value.trim() || !llmConfigured || !sourceReady;
  return (
    <div style={S.newSessionWrap}>
      {!llmConfigured && (
        <div style={{ padding: "0 14px 8px" }}>
          <LlmNotConfiguredInline />
        </div>
      )}
      <div style={S.sourceTabs} aria-label="Session source">
        {(["blank", "upload", "github"] as const).map((source) => (
          <button key={source} onClick={() => setSourceMode(source)} style={S.sourceTab(sourceMode === source)}>
            {source === "blank" ? "Blank" : source === "upload" ? "Upload" : "GitHub"}
          </button>
        ))}
      </div>
      {sourceMode === "upload" ? (
        <div style={S.sourcePanel}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            style={{ display: "none" }}
            aria-label="Upload files before session start"
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            // @ts-expect-error — webkitdirectory preserves folder upload paths in Chromium/WebKit
            webkitdirectory=""
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            style={{ display: "none" }}
            aria-label="Upload folder before session start"
          />
          <button type="button" onClick={() => fileInputRef.current?.click()} style={S.sourceMiniBtn}>Files</button>
          <button type="button" onClick={() => folderInputRef.current?.click()} style={S.sourceMiniBtn}>Folder</button>
          <span className="mono" style={S.sourceHint}>{files.length ? `${files.length} selected` : "files, folders, zips"}</span>
        </div>
      ) : null}
      {sourceMode === "github" ? (
        <div style={S.sourcePanel}>
          <input
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/org/repo"
            style={S.sourceInput}
            aria-label="GitHub repository URL"
          />
        </div>
      ) : null}
      <div style={S.newSession}>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim() && llmConfigured && sourceReady) void submit();
          }}
          placeholder={llmConfigured ? placeholder ?? `New ${mode} objective...` : "Configure OPENAI_API_KEY to add objectives"}
          style={S.newInput}
          disabled={creating || !llmConfigured}
        />
        <button
          onClick={() => void submit()}
          disabled={disabled}
          style={S.newBtn(disabled)}
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
  sourceTabs: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, padding: "10px 14px 0" } as React.CSSProperties,
  sourceTab: (active: boolean) => ({
    height: 27, borderRadius: 7, border: active ? "1px solid rgba(110,231,183,.32)" : border,
    background: active ? "rgba(110,231,183,.07)" : "transparent",
    color: active ? "var(--pulse)" : "var(--mist)", fontSize: 11, fontWeight: 700, cursor: "pointer",
  }) as React.CSSProperties,
  sourcePanel: { display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 0" } as React.CSSProperties,
  sourceMiniBtn: { height: 28, padding: "0 9px", borderRadius: 7, border, background: "rgba(255,255,255,.025)", color: "var(--mist)", fontSize: 11, fontWeight: 700, cursor: "pointer" } as React.CSSProperties,
  sourceInput: { flex: 1, background: surface, border, borderRadius: 7, padding: "8px 10px", color: "var(--bone)", fontSize: 12, outline: "none" } as React.CSSProperties,
  sourceHint: { color: "var(--haze)", fontSize: 10, whiteSpace: "nowrap" } as React.CSSProperties,
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
