"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Comment, CommentEntityType } from "@/lib/types";

// Agent roles for @mention autocomplete suggestions
const AGENT_MENTIONS = ["@CEO", "@Engineer", "@Growth", "@Content", "@Support", "@Analyst", "@Finance", "@Browser", "@Escalation"];

/** Render comment content with @mention highlighting */
function renderContent(content: string) {
  const parts = content.split(/(@\w+)/g);
  return parts.map((part, i) => {
    if (/^@\w+$/.test(part)) {
      const isAgent = AGENT_MENTIONS.some((m) => m.toLowerCase() === part.toLowerCase());
      return (
        <span
          key={i}
          style={{
            color: isAgent ? "var(--pulse)" : "#A5B4FC",
            fontFamily: isAgent ? "var(--mono)" : undefined,
            fontSize: isAgent ? "0.9em" : undefined,
            letterSpacing: isAgent ? ".04em" : undefined,
            fontWeight: 600,
          }}
        >
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function CommentThread({
  companyId,
  entityType,
  entityId,
  placeholder = "Ask a question or add context…",
  label = "discussion",
  collapsible = true,
}: {
  companyId: string;
  entityType: CommentEntityType;
  entityId: string;
  placeholder?: string;
  label?: string;
  collapsible?: boolean;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(!collapsible);
  const [mentionSuggestions, setMentionSuggestions] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/companies/${companyId}/comments?entityType=${entityType}&entityId=${entityId}`
    );
    if (res.ok) {
      const data = await res.json() as { comments: Comment[] };
      setComments(data.comments ?? []);
    }
    setLoading(false);
  }, [companyId, entityType, entityId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [comments, open]);

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setInput(val);
    // Detect @mention trigger
    const lastWord = val.split(/\s/).pop() ?? "";
    if (lastWord.startsWith("@") && lastWord.length > 0) {
      const query = lastWord.slice(1).toLowerCase();
      setMentionSuggestions(
        AGENT_MENTIONS.filter((m) => m.toLowerCase().slice(1).startsWith(query))
      );
    } else {
      setMentionSuggestions([]);
    }
  }

  function insertMention(mention: string) {
    const words = input.split(/(\s)/);
    words[words.length - 1] = mention + " ";
    setInput(words.join(""));
    setMentionSuggestions([]);
  }

  async function submit() {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, entityId, content: input.trim() }),
      });
      if (res.ok) {
        const data = await res.json() as { comment: Comment };
        setComments((prev) => [...prev, data.comment]);
        setInput("");
      }
    } finally {
      setSending(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  const count = comments.length;

  return (
    <div style={{ marginTop: 14 }}>
      {collapsible && (
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--haze)",
            fontFamily: "var(--mono)",
            fontSize: 9,
            letterSpacing: ".16em",
            textTransform: "uppercase",
            cursor: "pointer",
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {open ? "▲" : "▼"}{" "}
          {label}{count > 0 ? ` · ${count}` : ""}
        </button>
      )}

      {open && (
        <div
          style={{
            marginTop: collapsible ? 10 : 0,
            border: "1px solid rgba(255,255,255,.06)",
            borderRadius: 10,
            overflow: "hidden",
            background: "rgba(255,255,255,.015)",
          }}
        >
          {/* Comment list */}
          <div
            style={{
              maxHeight: 240,
              overflowY: "auto",
              padding: loading || count === 0 ? "14px 16px" : "10px 16px",
            }}
          >
            {loading ? (
              <div className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".12em" }}>loading…</div>
            ) : count === 0 ? (
              <div className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".1em" }}>
                no comments yet — start the discussion
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {comments.map((c) => (
                  <div key={c.id} style={{ display: "flex", gap: 10 }}>
                    {/* Avatar */}
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        background: c.agentRole
                          ? "rgba(110,231,183,.1)"
                          : "rgba(99,102,241,.1)",
                        border: c.agentRole
                          ? "1px solid rgba(110,231,183,.2)"
                          : "1px solid rgba(99,102,241,.2)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        flexShrink: 0,
                        color: c.agentRole ? "var(--pulse)" : "#A5B4FC",
                        fontFamily: "var(--mono)",
                        fontWeight: 600,
                      }}
                    >
                      {c.authorName.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 2 }}>
                        <span
                          className="mono"
                          style={{
                            fontSize: 9,
                            letterSpacing: ".1em",
                            textTransform: "uppercase",
                            color: c.agentRole ? "var(--pulse)" : "#A5B4FC",
                            fontWeight: 600,
                          }}
                        >
                          {c.authorName}
                        </span>
                        <span className="mono" style={{ fontSize: 8, color: "var(--haze)", letterSpacing: ".08em" }}>
                          {fmtTime(c.createdAt)}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "#B8B2A4",
                          lineHeight: 1.6,
                          wordBreak: "break-word",
                        }}
                      >
                        {renderContent(c.content)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: "rgba(255,255,255,.05)" }} />

          {/* Input */}
          <div style={{ padding: "8px 12px" }}>
            {/* @mention suggestions */}
            {mentionSuggestions.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                {mentionSuggestions.map((m) => (
                  <button
                    key={m}
                    onClick={() => insertMention(m)}
                    style={{
                      height: 22,
                      padding: "0 8px",
                      borderRadius: 999,
                      border: "1px solid rgba(110,231,183,.25)",
                      background: "rgba(110,231,183,.08)",
                      color: "var(--pulse)",
                      fontFamily: "var(--mono)",
                      fontSize: 9,
                      letterSpacing: ".08em",
                      cursor: "pointer",
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKey}
              rows={1}
              placeholder={placeholder}
              className="input"
              style={{
                flex: 1,
                resize: "none",
                minHeight: 32,
                maxHeight: 80,
                fontSize: 12,
                lineHeight: 1.5,
                overflowY: "auto",
                padding: "6px 10px",
              }}
            />
            <button
              onClick={() => void submit()}
              disabled={!input.trim() || sending}
              style={{
                height: 32,
                minWidth: 48,
                padding: "0 12px",
                borderRadius: 7,
                background: input.trim() && !sending ? "var(--pulse)" : "rgba(110,231,183,.1)",
                border: "none",
                color: input.trim() && !sending ? "#0A0A0F" : "var(--haze)",
                fontFamily: "var(--mono)",
                fontSize: 10,
                letterSpacing: ".1em",
                cursor: input.trim() && !sending ? "pointer" : "not-allowed",
                flexShrink: 0,
                transition: "all .15s",
              }}
            >
              {sending ? "…" : "send"}
            </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
