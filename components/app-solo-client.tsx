"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AgentActivityFeed, mapWorkbenchChunk, type ActivityStep } from "@/components/agent-activity";
import { styles } from "@/components/app-solo-client.styles";
import { getAppSoloAgents, type AppSoloAgent, type AppSoloApp, type AppSoloRunSummary } from "@/lib/app-solo";
import { APP_SOLO_REVIEW_EVIDENCE } from "@/lib/app-solo-product-review";
import type { WorkbenchAgentChunk } from "@/lib/workbench-agent-types";
import { cancelAppSoloRun, heartbeatAppSoloRun, launchAppSoloRun, resumeAppSoloRun } from "@/lib/app-solo-run";
import { AppSoloRunSummaryPanel } from "@/components/app-solo-run-summary-panel";
import { workbenchPreviewFrameSrc } from "@/lib/workbench-preview-url";
import { Eyebrow, I, Pill, PulseDot } from "@/components/ui";
import type { WorkbenchProvider, WorkbenchSession } from "@/lib/types";

export { AppSoloRunSummaryPanel } from "@/components/app-solo-run-summary-panel";

type AppSoloProviderChoice = "auto" | Extract<WorkbenchProvider, "daytona" | "e2b" | "mock_local">;

type LaunchState =
  | { status: "idle" }
  | { status: "launching" }
  | { status: "running"; session: WorkbenchSession; trace: ActivityStep[]; previewUrl?: string }
  | { status: "ready"; session: WorkbenchSession; trace: ActivityStep[]; previewUrl?: string; passed?: boolean; summary?: AppSoloRunSummary }
  | { status: "cancelled"; session: WorkbenchSession; trace: ActivityStep[]; previewUrl?: string }
  | { status: "error"; message: string; trace: ActivityStep[]; session?: WorkbenchSession; previewUrl?: string };

export function AppSoloClient({ companyId }: { companyId: string }) {
  const agents = useMemo(() => getAppSoloAgents(), []);
  const [selectedRole, setSelectedRole] = useState<AppSoloAgent["role"]>("growth");
  const selectedAgent = agents.find((agent) => agent.role === selectedRole) ?? agents[0];
  const [selectedAppId, setSelectedAppId] = useState<string>(selectedAgent.apps[0]?.id ?? "steel-browser");
  const [selectedProvider, setSelectedProvider] = useState<AppSoloProviderChoice>("auto");
  const selectedApp = selectedAgent.apps.find((app) => app.id === selectedAppId) ?? selectedAgent.apps[0];
  const [objective, setObjective] = useState("Create a focused solo run and show me the next useful artifact.");
  const [launch, setLaunch] = useState<LaunchState>({ status: "idle" });
  const selectedProviderRef = useRef<AppSoloProviderChoice>(selectedProvider);
  const [narrow, setNarrow] = useState(false);
  const activeSession = launch.status === "running" || launch.status === "ready" || launch.status === "cancelled"
    ? launch.session
    : launch.status === "error"
      ? launch.session
      : undefined;
  const activePreviewUrl = activeSession && "previewUrl" in launch
    ? launch.previewUrl ?? activeSession.previewUrl
    : undefined;
  const runningSessionId = launch.status === "running" ? launch.session.id : undefined;
  const previewSrc = activeSession && activePreviewUrl
    ? workbenchPreviewFrameSrc({ id: activeSession.id, previewUrl: activePreviewUrl })
    : "";

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 980);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!runningSessionId) return;
    const tick = () => heartbeatAppSoloRun(runningSessionId).catch(() => undefined);
    void tick();
    const interval = window.setInterval(tick, 15_000);
    return () => window.clearInterval(interval);
  }, [runningSessionId]);

  function selectAgent(agent: AppSoloAgent) {
    setSelectedRole(agent.role);
    setSelectedAppId(agent.apps[0]?.id ?? "steel-browser");
    setLaunch({ status: "idle" });
  }

  function selectProvider(provider: AppSoloProviderChoice) {
    selectedProviderRef.current = provider;
    setSelectedProvider(provider);
  }

  async function launchSoloRun(providerOverride?: "auto" | "daytona" | "e2b" | "mock_local") {
    if (!selectedApp) return;
    const provider = providerOverride ?? selectedProviderRef.current;
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
        provider: provider === "auto" ? undefined : provider,
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
            setLaunch({ status: "error", message: chunk.message, session: activeSession, trace: [...trace], previewUrl });
            return;
          }
          if (activeSession) setLaunch({ status: "running", session: activeSession, trace: [...trace], previewUrl });
        },
      });
      setLaunch({
        status: "ready",
        session: result.session,
        trace: [...trace],
        previewUrl: previewUrl ?? result.session.previewUrl,
        passed: result.summary.verification?.passed ?? passed,
        summary: result.summary,
      });
    } catch (err) {
      setLaunch({
        status: "error",
        message: err instanceof Error ? err.message : "agent run failed",
        session: activeSession,
        trace: [...trace],
        previewUrl,
      });
    }
  }

  async function resumeSoloRun() {
    if (!activeSession) return;
    const trace = "trace" in launch ? launch.trace : [];
    try {
      const session = await resumeAppSoloRun(activeSession.id);
      setLaunch({ status: "running", session, trace, previewUrl: activePreviewUrl });
    } catch (err) {
      setLaunch({
        status: "error",
        message: err instanceof Error ? err.message : "resume failed",
        session: activeSession,
        trace,
        previewUrl: activePreviewUrl,
      });
    }
  }

  async function cancelSoloRun() {
    if (!activeSession) return;
    const trace = "trace" in launch ? launch.trace : [];
    const session = await cancelAppSoloRun(activeSession.id);
    setLaunch({ status: "cancelled", session, trace, previewUrl: activePreviewUrl });
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
          {launch.status === "ready" && launch.summary && (
            <AppSoloRunSummaryPanel summary={launch.summary} />
          )}
          {(launch.status === "running" || launch.status === "ready" || launch.status === "error") && launch.trace.length > 0 && (
            <div style={styles.traceLog}>
              <AgentActivityFeed
                steps={launch.trace.slice(-12)}
                live={launch.status === "running"}
                aria-label="App solo live trace"
              />
            </div>
          )}
          {launch.status === "running" && (
            <button
              data-testid="app-solo-cancel-run"
              className="btn btn-mono"
              onClick={() => void cancelSoloRun()}
              style={{ ...styles.smallAction, marginTop: 10 }}
            >
              cancel run
            </button>
          )}
          {launch.status === "error" && (
            <div>
              <div data-testid="app-solo-launch-error" style={styles.errorText}>{launch.message}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {launch.session && (
                  <button
                    data-testid="app-solo-resume-run"
                    className="btn btn-mono"
                    onClick={() => void resumeSoloRun()}
                    style={styles.smallAction}
                  >
                    resume session
                  </button>
                )}
                <button
                  data-testid="app-solo-retry-launch"
                  className="btn btn-mono"
                  onClick={() => void launchSoloRun()}
                  style={styles.smallAction}
                >
                  retry launch
                </button>
                {selectedProvider !== "auto" && (
                  <button
                    data-testid="app-solo-retry-auto"
                    className="btn btn-mono"
                    onClick={() => { selectProvider("auto"); void launchSoloRun("auto"); }}
                    style={styles.smallAction}
                  >
                    retry with auto provider
                  </button>
                )}
              </div>
            </div>
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
                data-testid={`app-solo-provider-${provider}`}
                aria-pressed={selectedProvider === provider}
                onClick={() => selectProvider(provider)}
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
            data-testid="app-solo-start-run"
            onClick={() => void launchSoloRun()}
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
                {launch.status === "ready" || launch.status === "running" || launch.status === "cancelled"
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
      <ContractRow label="evidence" value={formatContractList(APP_SOLO_REVIEW_EVIDENCE, 4)} />
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

function formatContractList(items: readonly string[], maxItems: number): string {
  if (items.length === 0) return "none";
  const visible = items.slice(0, maxItems).join(", ");
  return items.length > maxItems ? `${visible}, +${items.length - maxItems} more` : visible;
}
