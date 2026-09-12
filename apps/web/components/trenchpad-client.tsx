"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleDot, FileCode2, GitBranch, Play, ShieldAlert, Terminal, X } from "lucide-react";
import { CeoCommandClient } from "@/components/ceo-command-client";
import {
  applyTrenchpadStreamEvent,
  createTrenchpadLiveState,
  type LiveFile,
  type TrenchpadAggregateLike,
  type TrenchpadLiveState,
  type WorkStreamItem,
} from "@/lib/trenchpad-live";
import type { AgentRole, WorkbenchSessionStatus } from "@/lib/types";
import type { TrenchpadStreamEvent, TrenchpadStreamEventType } from "@/lib/workbench-event-stream";

export const TRENCHPAD_CLIENT_CAPABILITIES = {
  layout: ["session_rail", "work_stream", "right_panel"],
  chatReuse: "CeoCommandClient",
  controls: ["inline_rename", "session_filters", "editable_planner", "playbooks", "secrets_env_panel", "wiki_search_handoff"],
  live: ["sse_eventsource", "terminal", "file_tree", "code_diff", "plan_status", "sandbox_preview", "inline_approval", "polling_fallback"],
} as const;

const streamEventTypes: TrenchpadStreamEventType[] = ["log", "command", "file_write", "plan_step", "artifact", "preview", "cost", "approval_required", "status"];

export function TrenchpadClient({ companyId }: { companyId: string }) {
  const [live, setLive] = useState<TrenchpadLiveState | null>(null);
  const [status, setStatus] = useState<WorkbenchSessionStatus | "all">("all");
  const [agentRole, setAgentRole] = useState<AgentRole | "all">("all");
  const [renaming, setRenaming] = useState<Record<string, string>>({});
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [manualSelectedFilePath, setManualSelectedFilePath] = useState<string | undefined>();
  const lastSeqRef = useRef(0);
  const terminalRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/companies/${companyId}/trenchpad`);
    if (!res.ok) return;
    const body = await res.json() as { trenchpad: TrenchpadAggregateLike };
    const state = createTrenchpadLiveState(body.trenchpad);
    lastSeqRef.current = state.lastSeq;
    setLive(state);
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeSessionId = live?.rightPanel.activeSessionId ?? live?.sessionRail.sessions[0]?.id;

  useEffect(() => {
    if (!activeSessionId) return;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let retryCount = 0;
    let closed = false;

    const applyEvent = (event: TrenchpadStreamEvent) => {
      setLive((current) => {
        if (!current) return current;
        const next = applyTrenchpadStreamEvent(current, event);
        lastSeqRef.current = next.lastSeq;
        return { ...next, connection: { ...next.connection, mode: "streaming" } };
      });
    };

    const startPolling = () => {
      setLive((current) => current ? { ...current, connection: { ...current.connection, mode: "polling" } } : current);
      pollTimer = setInterval(() => void load(), 5000);
    };

    const connect = () => {
      source?.close();
      source = new EventSource(`/api/app-builder/runs/${activeSessionId}/stream?companyId=${companyId}&seq=${lastSeqRef.current}`);
      source.onopen = () => {
        retryCount = 0;
        setLive((current) => current ? { ...current, connection: { ...current.connection, mode: "streaming" } } : current);
      };
      source.onerror = () => {
        source?.close();
        if (closed) return;
        retryCount += 1;
        setLive((current) => current ? { ...current, connection: { ...current.connection, mode: "reconnecting" } } : current);
        if (retryCount >= 4) {
          startPolling();
          return;
        }
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retryCount, 8000));
      };
      for (const type of streamEventTypes) {
        source.addEventListener(type, (message) => {
          const event = JSON.parse((message as MessageEvent<string>).data) as TrenchpadStreamEvent;
          applyEvent(event);
          if (event.type === "status" && ["completed", "failed", "cancelled"].includes(event.status)) source?.close();
        });
      }
    };

    connect();

    return () => {
      closed = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [activeSessionId, companyId, load]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const nearBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 80;
    if (nearBottom) terminal.scrollTop = terminal.scrollHeight;
  }, [live?.terminal.length]);

  const sessions = useMemo(() => {
    const all = live?.sessionRail.sessions ?? [];
    return all.filter((session) =>
      (status === "all" || session.status === status) &&
      (agentRole === "all" || session.agentRole === agentRole)
    );
  }, [live, status, agentRole]);

  const selectedFile = useMemo(() => {
    return live?.files.find((file) => file.path === (manualSelectedFilePath ?? live.selectedFilePath)) ?? live?.files[0];
  }, [live, manualSelectedFilePath]);

  async function renameSession(sessionId: string) {
    const objective = renaming[sessionId]?.trim();
    if (!objective) return;
    await fetch(`/api/workbench/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective }),
    });
    await load();
  }

  async function resolveInlineApproval(kind: "approved" | "rejected", title: string) {
    if (!activeSessionId) return;
    setApprovalBusy(kind);
    try {
      await fetch(`/api/app-builder/runs/${activeSessionId}/approval?companyId=${companyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: "deploy",
          decision: kind,
          estimatedCostCents: live?.headerUsage.remainingCents ?? 0,
          rollbackTarget: title,
        }),
      });
    } finally {
      setApprovalBusy(null);
    }
  }

  if (!live) return <div style={shellStyle}>Loading Trenchpad...</div>;

  return (
    <div style={shellStyle}>
      <header style={headerStyle}>
        <div>
          <div style={eyebrowStyle}>Trenchpad live</div>
          <h1 style={titleStyle}>Operator workspace</h1>
        </div>
        <div style={topStatsStyle}>
          <StatusPill mode={live.connection.mode} terminal={live.connection.terminal} />
          <UsageMeter spent={live.headerUsage.spentCents} budget={live.headerUsage.budgetCents} remaining={live.headerUsage.remainingCents} />
        </div>
      </header>

      <main style={gridStyle}>
        <aside style={railStyle}>
          <div style={sectionHeadStyle}><GitBranch size={15} /> Sessions</div>
          <div style={toolbarStyle}>
            <select aria-label="session status" value={status} onChange={(event) => setStatus(event.target.value as WorkbenchSessionStatus | "all")} style={selectStyle}>
              <option value="all">all statuses</option>
              {["queued", "starting", "running", "paused", "completed", "failed", "cancelled"].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <select aria-label="agent role" value={agentRole} onChange={(event) => setAgentRole(event.target.value as AgentRole | "all")} style={selectStyle}>
              <option value="all">all agents</option>
              {["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div style={sessionListStyle}>
            {sessions.map((session) => (
              <div key={session.id} style={session.id === activeSessionId ? activeSessionStyle : sessionStyle}>
                <input
                  aria-label={`rename ${session.id}`}
                  value={renaming[session.id] ?? session.objective}
                  onChange={(event) => setRenaming((prev) => ({ ...prev, [session.id]: event.target.value }))}
                  onBlur={() => void renameSession(session.id)}
                  style={inputStyle}
                />
                <div style={metaStyle}>{session.agentRole} / {session.status} / ${(session.costCents / 100).toFixed(2)}</div>
              </div>
            ))}
          </div>
          <div style={chatWrapStyle}>
            <CeoCommandClient companyId={companyId} />
          </div>
        </aside>

        <section style={workStyle}>
          <div style={sectionHeadStyle}><Terminal size={15} /> Live terminal</div>
          <div ref={terminalRef} style={terminalStyle}>
            {live.terminal.length === 0 ? <div style={emptyStyle}>Waiting for shell output...</div> : live.terminal.map((event) => (
              <TerminalRow key={event.id} event={event} />
            ))}
          </div>

          <div style={streamHeaderStyle}>
            <div style={sectionHeadStyle}><CircleDot size={15} /> Work stream</div>
            <span style={metaStyle}>{live.workStream.length} events / last seq {live.lastSeq}</span>
          </div>
          <div style={streamListStyle}>
            {live.workStream.map((event) => (
              <article key={event.id} id={event.id} style={eventStyle}>
                <div style={metaStyle}>{event.type} / {event.status} / seq {event.seq ?? "-"}</div>
                <strong>{event.title}</strong>
                <p style={contentStyle}>{event.content}</p>
              </article>
            ))}
          </div>
        </section>

        <aside style={rightStyle}>
          <div style={rightGridStyle}>
            <PanelTitle icon={<Play size={15} />} label="Plan" />
            <div style={planListStyle}>
              {live.plan.steps.map((step) => (
                <div key={step.id} style={stepStyle}>
                  <strong>{step.index + 1}. {step.title}</strong>
                  <div style={metaStyle}>{step.status}{step.approvalRequired ? " / approval" : ""}</div>
                </div>
              ))}
              {live.approvals.map((approval) => (
                <div key={approval.id} style={approvalStyle}>
                  <div style={sectionHeadStyle}><ShieldAlert size={15} /> Approval needed</div>
                  <strong>{approval.title}</strong>
                  <div style={metaStyle}>{approval.riskClass ?? "gated"} / seq {approval.seq}</div>
                  <div style={approvalControlsStyle}>
                    <button style={approveButtonStyle} disabled={approvalBusy !== null} onClick={() => void resolveInlineApproval("approved", approval.title)}><Check size={14} /> Approve</button>
                    <button style={rejectButtonStyle} disabled={approvalBusy !== null} onClick={() => void resolveInlineApproval("rejected", approval.title)}><X size={14} /> Reject</button>
                  </div>
                </div>
              ))}
            </div>

            <PanelTitle icon={<FileCode2 size={15} />} label="Files and code" />
            <div style={fileShellStyle}>
              <div style={fileTreeStyle}>
                {live.files.length === 0 ? <div style={emptyStyle}>No file writes yet.</div> : live.files.map((file) => (
                  <button key={file.path} style={file.path === selectedFile?.path ? activeFileButtonStyle : fileButtonStyle} onClick={() => setManualSelectedFilePath(file.path)}>{file.path}</button>
                ))}
              </div>
              <CodePane file={selectedFile} />
            </div>

            <PanelTitle icon={<Play size={15} />} label="Preview" />
            {live.previewUrl ? (
              <iframe title="Trenchpad live preview" src={live.previewUrl} sandbox="allow-forms allow-popups allow-scripts" style={previewStyle} />
            ) : <div style={previewEmptyStyle}>Preview will appear when the sandbox exposes a URL.</div>}

            <div style={metaRowStyle}>
              <span>{live.secrets.rendersSecretValues ? "secret rendering unsafe" : "secrets masked"}</span>
              <a href={`/companies/${companyId}/wiki`} style={linkStyle}>open cited wiki</a>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function TerminalRow({ event }: { event: WorkStreamItem }) {
  return (
    <div style={terminalRowStyle}>
      {event.command ? <div style={commandChipStyle}>$ {event.command}</div> : null}
      <pre style={terminalPreStyle}>{event.content}</pre>
    </div>
  );
}

function StatusPill({ mode, terminal }: { mode: TrenchpadLiveState["connection"]["mode"]; terminal: boolean }) {
  return <span style={mode === "polling" || mode === "reconnecting" ? warningPillStyle : pillStyle}>{terminal ? "terminal" : mode}</span>;
}

function UsageMeter({ spent, budget, remaining }: { spent: number; budget: number; remaining: number }) {
  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  return (
    <div style={usageStyle}>
      <div style={usageTextStyle}>spent ${(spent / 100).toFixed(2)} / remaining ${(remaining / 100).toFixed(2)}</div>
      <div style={meterTrackStyle}><div style={{ ...meterFillStyle, width: `${pct}%` }} /></div>
    </div>
  );
}

function PanelTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <div style={sectionHeadStyle}>{icon}{label}</div>;
}

function CodePane({ file }: { file?: LiveFile }) {
  if (!file) return <div style={codePaneStyle}><div style={emptyStyle}>Select a streamed file write.</div></div>;
  const content = file.diff ?? file.content ?? "";
  return (
    <div style={codePaneStyle}>
      <div style={codeHeadStyle}>{file.path}<span>{file.language ?? "text"}</span></div>
      <pre style={codePreStyle}>{content.split("\n").map((line, index) => `${String(index + 1).padStart(3, " ")}  ${line}`).join("\n")}</pre>
    </div>
  );
}

const shellStyle = { minHeight: "100vh", background: "#08090d", color: "#edf4ec", padding: 18, fontFamily: "Avenir Next, ui-sans-serif, system-ui, sans-serif" };
const headerStyle = { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 14 };
const titleStyle = { margin: 0, fontSize: 24, letterSpacing: 0 };
const gridStyle = { display: "grid", gridTemplateColumns: "286px minmax(420px, 1fr) 390px", gap: 10, minHeight: "calc(100vh - 92px)" };
const railStyle = { border: "1px solid #273125", background: "#10130f", padding: 12, minHeight: 0, display: "flex", flexDirection: "column" as const };
const workStyle = { border: "1px solid #273125", background: "#0c0f0d", padding: 12, minHeight: 0, display: "grid", gridTemplateRows: "280px auto 1fr", gap: 10 };
const rightStyle = { border: "1px solid #273125", background: "#11130f", padding: 12, minHeight: 0, overflow: "hidden" };
const rightGridStyle = { display: "grid", gap: 10, height: "100%", overflow: "auto" };
const eyebrowStyle = { color: "#9be15d", textTransform: "uppercase" as const, fontSize: 11, letterSpacing: 0, marginBottom: 4 };
const sectionHeadStyle = { display: "flex", alignItems: "center", gap: 7, color: "#bfe887", textTransform: "uppercase" as const, fontSize: 11, letterSpacing: 0, fontWeight: 700 };
const topStatsStyle = { display: "flex", alignItems: "center", gap: 12 };
const toolbarStyle = { display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr", marginBottom: 10 };
const selectStyle = { background: "#080a08", color: "#edf4ec", border: "1px solid #33402e", padding: 8, borderRadius: 6 };
const sessionListStyle = { display: "grid", gap: 8, overflow: "auto", minHeight: 160 };
const sessionStyle = { border: "1px solid #263026", background: "#0a0d0a", padding: 9, borderRadius: 8 };
const activeSessionStyle = { ...sessionStyle, border: "1px solid #9be15d", boxShadow: "0 0 0 1px rgba(155,225,93,.18)" };
const inputStyle = { width: "100%", background: "transparent", color: "#edf4ec", border: 0, padding: 0, outline: "none", fontWeight: 700 };
const metaStyle = { color: "#9caa98", fontSize: 12 };
const chatWrapStyle = { marginTop: "auto", borderTop: "1px solid #283225", paddingTop: 12 };
const terminalStyle = { background: "#050605", border: "1px solid #263026", borderRadius: 8, padding: 10, overflow: "auto", fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace" };
const terminalRowStyle = { marginBottom: 10 };
const commandChipStyle = { display: "inline-flex", background: "#1b2519", color: "#bff38b", border: "1px solid #35452f", borderRadius: 999, padding: "4px 8px", marginBottom: 5, fontSize: 12 };
const terminalPreStyle = { margin: 0, whiteSpace: "pre-wrap" as const, color: "#d7e6d3", fontSize: 12 };
const streamHeaderStyle = { display: "flex", justifyContent: "space-between", alignItems: "center" };
const streamListStyle = { overflow: "auto", display: "grid", alignContent: "start", gap: 8 };
const eventStyle = { border: "1px solid #263026", background: "#10140f", borderRadius: 8, padding: 10 };
const contentStyle = { margin: "6px 0 0", color: "#cbd8c7", fontSize: 13 };
const planListStyle = { display: "grid", gap: 7 };
const stepStyle = { border: "1px solid #263026", borderRadius: 8, padding: 9, background: "#0b0e0b" };
const approvalStyle = { border: "1px solid #b88934", background: "#211708", borderRadius: 8, padding: 10 };
const approvalControlsStyle = { display: "flex", gap: 8, marginTop: 8 };
const approveButtonStyle = { display: "inline-flex", alignItems: "center", gap: 5, background: "#9be15d", color: "#0a0d0a", border: 0, borderRadius: 6, padding: "7px 9px", fontWeight: 700 };
const rejectButtonStyle = { display: "inline-flex", alignItems: "center", gap: 5, background: "#301411", color: "#ffd3cc", border: "1px solid #7a3a31", borderRadius: 6, padding: "7px 9px", fontWeight: 700 };
const fileShellStyle = { display: "grid", gridTemplateColumns: "135px 1fr", gap: 8, minHeight: 230 };
const fileTreeStyle = { border: "1px solid #263026", borderRadius: 8, padding: 6, overflow: "auto" };
const fileButtonStyle = { width: "100%", textAlign: "left" as const, background: "transparent", color: "#ccd8c8", border: 0, padding: "6px 5px", borderRadius: 5, fontSize: 12 };
const activeFileButtonStyle = { ...fileButtonStyle, background: "#26361e", color: "#edffe6" };
const codePaneStyle = { border: "1px solid #263026", borderRadius: 8, overflow: "hidden", background: "#070807", minHeight: 230 };
const codeHeadStyle = { display: "flex", justifyContent: "space-between", padding: "7px 9px", borderBottom: "1px solid #263026", color: "#d7e6d3", fontSize: 12 };
const codePreStyle = { margin: 0, padding: 10, overflow: "auto", minHeight: 190, fontSize: 12, lineHeight: 1.55, color: "#e7f2e3", fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace" };
const previewStyle = { width: "100%", height: 260, border: "1px solid #263026", borderRadius: 8, background: "#ffffff" };
const previewEmptyStyle = { border: "1px solid #263026", borderRadius: 8, padding: 18, color: "#9caa98", minHeight: 110 };
const metaRowStyle = { display: "flex", justifyContent: "space-between", gap: 10, color: "#9caa98", fontSize: 12 };
const linkStyle = { color: "#bfe887" };
const emptyStyle = { color: "#7f8d7a", fontSize: 13 };
const usageStyle = { display: "grid", gap: 5, minWidth: 230 };
const usageTextStyle = { color: "#d7e6d3", fontSize: 12 };
const meterTrackStyle = { height: 7, borderRadius: 999, background: "#263026", overflow: "hidden" };
const meterFillStyle = { height: "100%", background: "#9be15d" };
const pillStyle = { color: "#0a0d0a", background: "#9be15d", borderRadius: 999, padding: "6px 10px", fontSize: 12, fontWeight: 700 };
const warningPillStyle = { ...pillStyle, background: "#e4b45b" };
