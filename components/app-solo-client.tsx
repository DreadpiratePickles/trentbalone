"use client";

import React, { useEffect, useMemo, useState, type CSSProperties } from "react";
import { AgentActivityFeed, mapWorkbenchChunk, type ActivityStep } from "@/components/agent-activity";
import { getAppSoloAgents, type AppSoloAgent, type AppSoloApp } from "@/lib/app-solo";
import type { WorkbenchAgentChunk } from "@/lib/workbench-agent-types";
import { launchAppSoloRun } from "@/lib/app-solo-run";
import { workbenchPreviewFrameSrc } from "@/lib/workbench-preview-url";
import { Eyebrow, I, Pill, PulseDot } from "@/components/ui";
import type { WorkbenchProvider, WorkbenchSession } from "@/lib/types";

type AppSoloProviderChoice = "auto" | Extract<WorkbenchProvider, "daytona" | "e2b" | "mock_local">;

type LaunchState =
  | { status: "idle" }
  | { status: "launching" }
  | { status: "running"; session: WorkbenchSession; trace: ActivityStep[]; previewUrl?: string }
  | { status: "ready"; session: WorkbenchSession; trace: ActivityStep[]; previewUrl?: string; passed?: boolean }
  | { status: "error"; message: string; trace: ActivityStep[] };

export function AppSoloClient({ companyId }: { companyId: string }) {
  const agents = useMemo(() => getAppSoloAgents(), []);
  const [selectedRole, setSelectedRole] = useState<AppSoloAgent["role"]>("growth");
  const selectedAgent = agents.find((agent) => agent.role === selectedRole) ?? agents[0];
  const [selectedAppId, setSelectedAppId] = useState<string>(selectedAgent.apps[0]?.id ?? "steel-browser");
  const [selectedProvider, setSelectedProvider] = useState<AppSoloProviderChoice>("auto");
  const selectedApp = selectedAgent.apps.find((app) => app.id === selectedAppId) ?? selectedAgent.apps[0];
  const [objective, setObjective] = useState("Create a focused solo run and show me the next useful artifact.");
  const [launch, setLaunch] = useState<LaunchState>({ status: "idle" });
  const [narrow, setNarrow] = useState(false);
  const activeSession = launch.status === "running" || launch.status === "ready" ? launch.session : undefined;
  const activePreviewUrl = launch.status === "running" || launch.status === "ready"
    ? launch.previewUrl ?? launch.session.previewUrl
    : undefined;
  const previewSrc = activeSession && activePreviewUrl
    ? workbenchPreviewFrameSrc({ id: activeSession.id, previewUrl: activePreviewUrl })
    : "";

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 980);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function selectAgent(agent: AppSoloAgent) {
    setSelectedRole(agent.role);
    setSelectedAppId(agent.apps[0]?.id ?? "steel-browser");
    setLaunch({ status: "idle" });
  }

  async function launchSoloRun() {
    if (!selectedApp) return;
    setLaunch({ status: "launching" });

    const trace: ActivityStep[] = [];
    let activeSession: WorkbenchSession | undefined;
    let previewUrl: string | undefined;
    let passed: boolean | undefined;
    try {
      const result = await launchAppSoloRun({
        companyId,
        agent: selectedAgent,
        app: selectedApp,
        objective,
        provider: selectedProvider === "auto" ? undefined : selectedProvider,
        onSessionCreated: (session) => {
          activeSession = session;
          trace.push({
            id: "solo-session-created",
            icon: "status",
            verb: "Sandbox session created",
            status: "completed",
          });
          setLaunch({ status: "running", session, trace: [...trace] });
        },
        onChunk: (chunk: WorkbenchAgentChunk) => {
          const step = mapWorkbenchChunk(chunk, trace.length);
          if (step) trace.push(step);
          if (chunk.type === "preview") previewUrl = chunk.url;
          if (chunk.type === "verify") passed = chunk.passed;
          if (chunk.type === "error" && activeSession) {
            setLaunch({ status: "error", message: chunk.message, trace: [...trace] });
            return;
          }
          if (activeSession) setLaunch({ status: "running", session: activeSession, trace: [...trace], previewUrl });
        },
      });
      setLaunch({ status: "ready", session: result.session, trace: [...trace], previewUrl: previewUrl ?? result.session.previewUrl, passed });
    } catch (err) {
      setLaunch({ status: "error", message: err instanceof Error ? err.message : "agent run failed", trace: [...trace] });
    }
  }

  return (
    <div style={{ ...styles.shell, gridTemplateColumns: narrow ? "1fr" : "minmax(280px, 360px) minmax(0, 1fr)" }}>
      <aside style={{ ...styles.leftRail, minHeight: narrow ? "auto" : 720 }}>
        <div style={styles.leftHeader}>
          <Eyebrow>app solo</Eyebrow>
          <h1 style={styles.title}>One agent. Full capability.</h1>
          <p style={styles.lead}>
            Pick a seat, run one sandbox, and watch the work stay scoped to that agent.
          </p>
        </div>

        <div style={styles.agentStack}>
          {agents.map((agent) => (
            <button
              key={agent.role}
              onClick={() => selectAgent(agent)}
              style={{
                ...styles.agentButton,
                borderColor: agent.role === selectedAgent.role ? "rgba(110,231,183,.38)" : "rgba(255,255,255,.07)",
                background: agent.role === selectedAgent.role ? "rgba(110,231,183,.08)" : "rgba(255,255,255,.025)",
              }}
            >
              <span style={styles.agentCode}>{agent.label.slice(0, 2).toUpperCase()}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={styles.agentName}>{agent.label}</span>
                <span style={styles.agentMeta}>{agent.apps.map((app) => app.name).join(" / ")}</span>
              </span>
              {agent.role === selectedAgent.role && <PulseDot size={7} />}
            </button>
          ))}
        </div>

        <div style={styles.activityPanel}>
          <div style={styles.panelTitle}>live trace</div>
          <AgentContractSummary agent={selectedAgent} app={selectedApp} />
          <TraceLine active label={`${selectedAgent.label} selected`} />
          <TraceLine active={!!selectedApp} label={`${selectedApp?.name ?? "Sandbox"} armed`} />
          <TraceLine active label={`${selectedProvider === "auto" ? "auto" : selectedProvider} sandbox provider`} />
          <TraceLine
            active={launch.status === "launching" || launch.status === "running" || launch.status === "ready"}
            label="Workbench session requested"
          />
          <TraceLine
            active={launch.status === "running" || launch.status === "ready"}
            label={launch.status === "running" ? "Agent running…" : "Agent run complete"}
          />
          {(launch.status === "running" || launch.status === "ready" || launch.status === "error") && launch.trace.length > 0 && (
            <div style={styles.traceLog}>
              <AgentActivityFeed
                steps={launch.trace.slice(-12)}
                live={launch.status === "running"}
                aria-label="App solo live trace"
              />
            </div>
          )}
          {launch.status === "error" && (
            <div style={styles.errorText}>{launch.message}</div>
          )}
        </div>

        <div style={styles.promptDock}>
          <label style={styles.label} htmlFor="app-solo-objective">objective</label>
          <textarea
            id="app-solo-objective"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            style={styles.textarea}
            rows={4}
          />
          <div style={styles.segmentedControl} aria-label="sandbox provider">
            {(["auto", "daytona", "e2b", "mock_local"] as const).map((provider) => (
              <button
                key={provider}
                type="button"
                onClick={() => setSelectedProvider(provider)}
                style={{
                  ...styles.segmentButton,
                  borderColor: selectedProvider === provider ? "rgba(110,231,183,.5)" : "rgba(255,255,255,.08)",
                  color: selectedProvider === provider ? "var(--pulse)" : "var(--haze)",
                  background: selectedProvider === provider ? "rgba(110,231,183,.08)" : "rgba(255,255,255,.025)",
                }}
              >
                {provider === "mock_local" ? "local" : provider}
              </button>
            ))}
          </div>
          <button
            className="btn btn-pulse btn-mono"
            onClick={launchSoloRun}
            disabled={launch.status === "launching" || launch.status === "running" || !selectedApp}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {launch.status === "launching" ? "launching" : launch.status === "running" ? "agent running…" : "start solo run"}
          </button>
        </div>
      </aside>

      <main style={styles.stage}>
        <div style={styles.stageToolbar}>
          <div style={styles.windowDots}><span style={styles.windowDot} /><span style={styles.windowDot} /><span style={styles.windowDot} /></div>
          <div style={styles.pathBar}>
            <I.globe />
            <span>/app-solo/{selectedAgent.role}/{selectedApp?.id ?? "sandbox"}</span>
          </div>
          <Pill tone={launch.status === "ready" ? "pulse" : launch.status === "launching" ? "ember" : "neutral"}>
            {launch.status}
          </Pill>
        </div>

        <section style={styles.heroSandbox}>
          <div style={styles.gridGlow} />
          {previewSrc ? (
            <div style={styles.previewShell}>
              <iframe
                title={`${selectedAgent.label} ${selectedApp?.name ?? "sandbox"} preview`}
                src={previewSrc}
                style={styles.previewFrame}
                sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
              />
            </div>
          ) : (
            <>
              <div style={styles.stageTopline}>
                <span style={styles.squareMark}><I.play /></span>
                <span>trent solo workspace</span>
              </div>
              <div style={styles.kicker}>{selectedAgent.label} / {selectedAgent.defaultName}</div>
              <h2 style={styles.stageTitle}>{selectedApp?.name ?? "Sandbox"} is loaded.</h2>
              <p style={styles.stageCopy}>{selectedAgent.mission}</p>

              <div style={styles.appGrid}>
                {selectedAgent.apps.map((app) => (
                  <AppCard
                    key={app.id}
                    app={app}
                    active={app.id === selectedApp?.id}
                    onClick={() => setSelectedAppId(app.id)}
                  />
                ))}
              </div>
            </>
          )}

          <div style={styles.outputBand}>
            <div>
              <div style={styles.bandLabel}>session output</div>
              <div style={styles.bandTitle}>
                {launch.status === "ready" || launch.status === "running"
                  ? launch.session.objective.slice(0, 82)
                  : "Preview will appear after the solo run starts."}
              </div>
            </div>
            <div style={styles.bandActions}>
              <span>{selectedAgent.deliverables.length} deliverables</span>
              <span>{selectedAgent.approvalGates.length} gates</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function AppCard({ app, active, onClick }: { app: AppSoloApp; active: boolean; onClick: () => void }) {
  const color = app.accent === "ember" ? "var(--ember)" : app.accent === "bone" ? "var(--bone)" : "var(--pulse)";
  return (
    <button
      onClick={onClick}
      style={{
        ...styles.appCard,
        borderColor: active ? color : "rgba(255,255,255,.08)",
        boxShadow: active ? `0 0 0 1px ${color}33, 0 18px 60px rgba(0,0,0,.28)` : "none",
      }}
    >
      <span style={{ ...styles.appLabel, color }}>{app.label}</span>
      <span style={styles.appName}>{app.name}</span>
      <span style={styles.appDescription}>{app.description}</span>
      <span style={styles.scopeCount}>{app.scopes.length} scopes</span>
    </button>
  );
}

function TraceLine({ active, label }: { active: boolean; label: string }) {
  return (
    <div style={styles.traceLine}>
      <span style={{ ...styles.traceDot, background: active ? "var(--pulse)" : "rgba(255,255,255,.14)" }} />
      <span style={{ color: active ? "var(--bone)" : "var(--haze)" }}>{label}</span>
    </div>
  );
}

function AgentContractSummary({ agent, app }: { agent: AppSoloAgent; app?: AppSoloApp }) {
  return (
    <div style={styles.contractPanel} aria-label="App Solo agent contract">
      <div style={styles.contractTitle}>agent contract</div>
      <ContractRow label="seat" value={agent.label} />
      <ContractRow label="app" value={app?.name ?? "Sandbox"} />
      <ContractRow label="mode" value={agent.mode} />
      <ContractRow label="scopes" value={formatContractList(app?.scopes ?? [], 4)} />
      <ContractRow label="deliverables" value={formatContractList(agent.deliverables, 4)} />
      <ContractRow label="approval gates" value={formatContractList(agent.approvalGates, 5)} />
    </div>
  );
}

function ContractRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.contractRow}>
      <span style={styles.contractLabel}>{label}</span>
      <span style={styles.contractValue}>{value}</span>
    </div>
  );
}

function formatContractList(items: string[], maxItems: number): string {
  if (items.length === 0) return "none";
  const visible = items.slice(0, maxItems).join(", ");
  return items.length > maxItems ? `${visible}, +${items.length - maxItems} more` : visible;
}

const styles: Record<string, CSSProperties> = {
  shell: {
    minHeight: "calc(100vh - 150px)",
    display: "grid",
    gap: 18,
  },
  leftRail: {
    minHeight: 720,
    display: "grid",
    gridTemplateRows: "auto 1fr auto auto",
    gap: 18,
    padding: 18,
    border: "1px solid rgba(255,255,255,.08)",
    borderRadius: 8,
    background: "linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.02))",
  },
  leftHeader: { borderBottom: "1px solid rgba(255,255,255,.07)", paddingBottom: 18 },
  title: { margin: "10px 0 10px", fontFamily: "var(--display)", fontSize: 40, lineHeight: .95, letterSpacing: 0, color: "var(--bone)" },
  lead: { margin: 0, color: "var(--mist)", lineHeight: 1.55, fontSize: 14 },
  agentStack: { display: "grid", alignContent: "start", gap: 8, overflow: "auto", paddingRight: 2 },
  agentButton: {
    minHeight: 58,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.07)",
    borderRadius: 8,
    color: "var(--bone)",
    cursor: "pointer",
    textAlign: "left",
  },
  agentCode: {
    width: 34,
    height: 34,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid rgba(110,231,183,.28)",
    color: "var(--pulse)",
    fontFamily: "var(--mono)",
    fontSize: 10,
    letterSpacing: ".12em",
  },
  agentName: { display: "block", fontWeight: 650, fontSize: 13 },
  agentMeta: { display: "block", marginTop: 3, color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  activityPanel: { padding: 14, border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, background: "rgba(10,10,15,.42)" },
  panelTitle: { fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 12 },
  contractPanel: { display: "grid", gap: 7, padding: "0 0 12px", marginBottom: 10, borderBottom: "1px solid rgba(255,255,255,.06)" },
  contractTitle: { fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--pulse)" },
  contractRow: { display: "grid", gridTemplateColumns: "92px minmax(0, 1fr)", gap: 8, alignItems: "start", fontSize: 12, lineHeight: 1.35 },
  contractLabel: { fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--haze)" },
  contractValue: { color: "var(--bone)", overflowWrap: "anywhere" },
  traceLine: { display: "flex", alignItems: "center", gap: 9, minHeight: 26, fontSize: 13 },
  traceDot: { width: 6, height: 6, borderRadius: 999, boxShadow: "0 0 18px rgba(110,231,183,.3)" },
  errorText: { marginTop: 10, color: "#FCA5A5", fontSize: 12, lineHeight: 1.45 },
  traceLog: { marginTop: 10, display: "grid", gap: 3, maxHeight: 180, overflow: "auto", paddingTop: 8, borderTop: "1px solid rgba(255,255,255,.06)" },
  traceLogLine: { fontFamily: "var(--font-mono, monospace)", fontSize: 11, lineHeight: 1.5, color: "rgba(255,255,255,.62)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  promptDock: { display: "grid", gap: 10 },
  label: { fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".16em", color: "var(--haze)", textTransform: "uppercase" },
  textarea: { width: "100%", resize: "vertical", minHeight: 92, borderRadius: 8, border: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.035)", color: "var(--bone)", padding: 12, lineHeight: 1.45 },
  segmentedControl: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 },
  segmentButton: { minHeight: 34, border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", cursor: "pointer" },
  stage: { minWidth: 0, border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, overflow: "hidden", background: "rgba(255,255,255,.025)" },
  stageToolbar: { height: 54, display: "flex", alignItems: "center", gap: 12, padding: "0 14px", borderBottom: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.035)" },
  windowDots: { display: "flex", gap: 7 },
  windowDot: { width: 9, height: 9, borderRadius: 999, background: "rgba(255,255,255,.18)" },
  pathBar: { minWidth: 0, flex: 1, height: 32, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 11 },
  heroSandbox: { position: "relative", minHeight: 666, padding: "42px min(5vw, 58px)", overflow: "hidden", background: "radial-gradient(circle at 78% 18%, rgba(110,231,183,.16), transparent 32%), linear-gradient(135deg, #0A0A0F 0%, #111116 52%, #090A0C 100%)" },
  previewShell: { position: "relative", minHeight: 560, display: "grid", border: "1px solid rgba(255,255,255,.12)", borderRadius: 8, overflow: "hidden", background: "rgba(255,255,255,.04)" },
  previewFrame: { width: "100%", minHeight: 560, border: 0, background: "#fff" },
  gridGlow: { position: "absolute", inset: 0, opacity: .18, backgroundImage: "linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px)", backgroundSize: "48px 48px", maskImage: "linear-gradient(90deg, black, transparent 78%)" },
  stageTopline: { position: "relative", display: "flex", alignItems: "center", gap: 12, fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--pulse)", marginBottom: 52 },
  squareMark: { width: 34, height: 34, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--pulse)", color: "var(--obsidian)" },
  kicker: { position: "relative", display: "inline-flex", padding: "10px 14px", border: "1px solid rgba(110,231,183,.45)", color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 22 },
  stageTitle: { position: "relative", maxWidth: 820, margin: 0, fontFamily: "var(--display)", fontSize: "clamp(48px, 7vw, 104px)", lineHeight: .88, letterSpacing: 0, color: "var(--bone)" },
  stageCopy: { position: "relative", maxWidth: 720, margin: "24px 0 34px", color: "var(--bone-2)", fontSize: 17, lineHeight: 1.7 },
  appGrid: { position: "relative", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginBottom: 32 },
  appCard: { minHeight: 138, padding: 16, textAlign: "left", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, background: "rgba(10,10,15,.68)", color: "var(--bone)", cursor: "pointer" },
  appLabel: { display: "block", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 14 },
  appName: { display: "block", fontSize: 18, fontWeight: 760, marginBottom: 8 },
  appDescription: { display: "block", color: "var(--mist)", fontSize: 12, lineHeight: 1.45 },
  scopeCount: { display: "inline-flex", marginTop: 12, fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--haze)" },
  outputBand: { position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20, padding: 20, border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, background: "rgba(255,255,255,.035)" },
  bandLabel: { fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--pulse)", marginBottom: 8 },
  bandTitle: { color: "var(--bone)", fontWeight: 650, lineHeight: 1.4 },
  bandActions: { display: "flex", gap: 10, flexWrap: "wrap", color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase" },
};
