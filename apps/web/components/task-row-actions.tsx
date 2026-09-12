"use client";

import { useState } from "react";
import type { Task } from "@/lib/types";
import { readApiError } from "@/lib/read-api-error";

type ActionState = "idle" | "loading" | "done" | "error";

export function TaskRowActions({ task }: { task: Task }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [githubState, setGithubState] = useState<ActionState>("idle");
  const [gmailState, setGmailState] = useState<ActionState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const canGitHubIssue = task.agentRole === "engineer";

  async function createGitHubIssue() {
    setGithubState("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}/github-issue`, { method: "POST" });
      if (!res.ok) {
        setMessage(await readApiError(res));
        setGithubState("error");
        return;
      }
      const data = await res.json() as { result?: { status?: string; issueUrl?: string } };
      if (data.result?.status === "needs_approval") {
        setMessage("GitHub issue queued — pending approval.");
      } else if (data.result?.issueUrl) {
        setMessage(`Issue created: ${data.result.issueUrl}`);
      } else {
        setMessage("GitHub issue request submitted.");
      }
      setGithubState("done");
    } catch {
      setMessage("GitHub issue request failed.");
      setGithubState("error");
    } finally {
      setMenuOpen(false);
    }
  }

  async function createGmailDraft() {
    setGmailState("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}/gmail-draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        setMessage(await readApiError(res));
        setGmailState("error");
        return;
      }
      setMessage("Gmail draft created.");
      setGmailState("done");
    } catch {
      setMessage("Gmail draft failed.");
      setGmailState("error");
    } finally {
      setMenuOpen(false);
    }
  }

  const busy = githubState === "loading" || gmailState === "loading";

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={busy}
        title="Task actions"
        className="mono"
        style={{
          background: "transparent",
          border: "1px solid rgba(255,255,255,.08)",
          borderRadius: 6,
          color: menuOpen ? "var(--pulse)" : "var(--haze)",
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: busy ? "wait" : "pointer",
          fontSize: 11,
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 20,
            minWidth: 180,
            background: "var(--ink)",
            border: "1px solid rgba(255,255,255,.1)",
            borderRadius: 10,
            padding: 6,
            boxShadow: "0 12px 40px rgba(0,0,0,.45)",
          }}
        >
          {canGitHubIssue && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ width: "100%", justifyContent: "flex-start", fontSize: 12, marginBottom: 4 }}
              disabled={busy}
              onClick={() => void createGitHubIssue()}
            >
              {githubState === "loading" ? "creating issue…" : "create GitHub issue"}
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            style={{ width: "100%", justifyContent: "flex-start", fontSize: 12 }}
            disabled={busy}
            onClick={() => void createGmailDraft()}
          >
            {gmailState === "loading" ? "drafting…" : "draft Gmail"}
          </button>
        </div>
      )}
      {message && (
        <div
          className="mono"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 19,
            maxWidth: 280,
            fontSize: 10,
            color: githubState === "error" || gmailState === "error" ? "var(--danger)" : "var(--pulse)",
            padding: "6px 8px",
            background: "var(--steel)",
            borderRadius: 8,
            marginTop: menuOpen ? 88 : 0,
            pointerEvents: "none",
          }}
        >
          {message}
        </div>
      )}
    </div>
  );
}
