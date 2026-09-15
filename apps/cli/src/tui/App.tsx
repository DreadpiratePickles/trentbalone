import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { P } from "./palette.js";
import {
  ConfigManager,
  FleetManager,
  SessionManager,
  ApprovalBridge,
  DoctorRunner,
  FixRunner,
  type ApprovalRequest,
  type DoctorReport,
  type Toolset,
  type Provider,
} from "@trent/core";
import { createOrchestrator, type Orchestrator } from "@trent/core/orchestrator/index.js";
import { handleOrcEvent, type OrchestratorApprovalDetails } from "./events.js";
import { CLI_VERSION } from "../commands/registry.js";
import { Sidebar } from "./Sidebar.js";
import { Chat } from "./Chat.js";
import { Activity } from "./Activity.js";
import { useFleet } from "./hooks/useFleet.js";
import { useApprovals } from "./hooks/useApprovals.js";
import { useBudget } from "./hooks/useBudget.js";
import { useSession } from "./hooks/useSession.js";
import type { TuiActivityItem } from "./types.js";
import {
  ModelModal,
  FleetModal,
  ToolsModal,
  DoctorModal,
  HelpModal,
} from "./modals/index.js";

export interface AppProps {
  configManager?: ConfigManager;
  fleetManager?: FleetManager;
  sessionManager?: SessionManager;
  approvalBridge?: ApprovalBridge;
  /** The event source for every turn. Defaults to the real in-process orchestrator. */
  orchestrator?: Orchestrator;
}

const DEFAULT_COMPANY_ID = "trent-local";

function orchestratorApproval(request: ApprovalRequest): OrchestratorApprovalDetails | undefined {
  const { runId, stepId } = request.details;
  if (typeof runId !== "string" || typeof stepId !== "string") return undefined;
  return { runId, stepId };
}

export const App: React.FC<AppProps> = (props) => {
  const configManager = props.configManager || new ConfigManager();
  const fleetManager = props.fleetManager || new FleetManager(configManager);
  const sessionManager = props.sessionManager || new SessionManager(configManager);
  const approvalBridge = props.approvalBridge || new ApprovalBridge();
  const doctorRunner = new DoctorRunner(configManager);
  const [orchestrator] = useState<Orchestrator>(() => props.orchestrator ?? createOrchestrator());

  const fleet = useFleet(fleetManager);
  const { pending, approve, deny } = useApprovals(approvalBridge);
  const budget = useBudget(configManager, fleet.dailyBudgetSpentCents);
  const { session, appendUserMessage, appendAgentMessage } = useSession(sessionManager);
  const [busy, setBusy] = useState(false);

  const [activeModal, setActiveModal] = useState<
    "none" | "model" | "fleet" | "tools" | "doctor" | "help"
  >("none");
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);

  const config = configManager.loadConfig();
  const companyId = String((config as { company?: { id?: string } }).company?.id ?? DEFAULT_COMPANY_ID);

  // A decision taken in the approval queue is routed back to the step that is waiting on it.
  useEffect(() => {
    const onDecided = (request: ApprovalRequest): void => {
      const link = orchestratorApproval(request);
      if (link === undefined) return;
      if (request.status === "approved") void orchestrator.approve(link.runId, link.stepId);
      else void orchestrator.reject(link.runId, link.stepId);
    };
    approvalBridge.on("approval_decided", onDecided);
    return () => {
      approvalBridge.off("approval_decided", onDecided);
    };
  }, [approvalBridge, orchestrator]);

  useInput((input, key) => {
    if (activeModal !== "none") return;

    // y / n answer the oldest pending approval, exactly as the queue pane advertises.
    const [oldest] = pending;
    if (oldest !== undefined && !key.ctrl && !key.meta) {
      if (input === "y") {
        approve(oldest.id);
        return;
      }
      if (input === "n") {
        deny(oldest.id);
        return;
      }
    }

    if (key.ctrl && input === "m") {
      setActiveModal("model");
    } else if (key.ctrl && input === "f") {
      setActiveModal("fleet");
    } else if (key.ctrl && input === "t") {
      setActiveModal("tools");
    } else if (key.ctrl && input === "d") {
      doctorRunner.runAll().then((r) => {
        setDoctorReport(r);
        setActiveModal("doctor");
      });
    } else if (key.ctrl && input === "h") {
      setActiveModal("help");
    } else if (key.ctrl && input === "c") {
      process.exit(0);
    }
  });

  const [activities, setActivities] = useState<TuiActivityItem[]>([]);

  const pushActivity = (item: Omit<TuiActivityItem, "id" | "timestamp">): void => {
    const at = new Date().toISOString();
    setActivities((prev) => [{ id: `act-${at}-${prev.length}`, timestamp: at, ...item }, ...prev.slice(0, 8)]);
  };

  /** One real orchestrated turn. Every line shown comes from an event; nothing is invented. */
  const runObjective = async (objective: string): Promise<void> => {
    setBusy(true);
    try {
      for await (const event of orchestrator.run({ companyId, objective, trigger: "manual" })) {
        handleOrcEvent(event, {
          recordCost: budget.record,
          appendAgentMessage,
          pushActivity,
          sessionAgent: session.agent,
          openApproval: ({ agent, action, runId, stepId, reason }) => {
            approvalBridge.createApprovalRequest(agent, action, { runId, stepId, reason });
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendAgentMessage("orchestrator", `Run failed: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSendMessage = async (text: string) => {
    const trimmed = text.trim();

    // Check for interactive slash command triggers
    if (trimmed === "/model") {
      setActiveModal("model");
      return;
    }
    if (trimmed === "/fleet") {
      setActiveModal("fleet");
      return;
    }
    if (trimmed === "/tools") {
      setActiveModal("tools");
      return;
    }
    if (trimmed === "/doctor") {
      const report = await doctorRunner.runAll();
      setDoctorReport(report);
      setActiveModal("doctor");
      return;
    }
    if (trimmed === "/help") {
      setActiveModal("help");
      return;
    }
    if (trimmed === "/exit" || trimmed === "/quit") {
      process.exit(0);
    }

    if (busy) return;
    appendUserMessage(text);
    await runObjective(text);
  };

  const handleSelectModel = (provider: string, model: string) => {
    configManager.updateConfig({ provider: provider as Provider, model });
  };

  const handleDeployAgent = (agentId: string) => {
    fleetManager.deploy(agentId);
  };

  const handleToggleToolset = (toolset: string) => {
    const currentToolsets = (config.toolsets || []) as Toolset[];
    const currentDisabled = (config.disabled_toolsets || []) as Toolset[];
    const t = toolset as Toolset;

    if (currentToolsets.includes(t)) {
      configManager.updateConfig({
        toolsets: currentToolsets.filter((item) => item !== t),
        disabled_toolsets: [...currentDisabled, t],
      });
    } else {
      configManager.updateConfig({
        toolsets: [...currentToolsets, t],
        disabled_toolsets: currentDisabled.filter((item) => item !== t),
      });
    }
  };

  const activeAgentIds = fleet.agents.filter((a) => a.active).map((a) => a.id);
  const installedAgentIds = fleet.agents.filter((a) => a.installed).map((a) => a.id);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Top Header Bar */}
      <Box
        borderStyle="single"
        borderColor={P.accent}
        paddingX={1}
        justifyContent="space-between"
      >
        <Box>
          <Text bold color={P.accent}>
            TRENT FLEET{" "}
          </Text>
          <Text dimColor color={P.muted}>
            v{CLI_VERSION}
          </Text>
        </Box>
        <Box>
          <Text color={P.muted}>Model: </Text>
          <Text bold color={P.info}>
            {config.model}{" "}
          </Text>
          <Text color={P.muted}>({config.provider})</Text>
        </Box>
        <Box>
          <Text dimColor color={P.dim}>
            Commands: /model /fleet /tools /doctor /help
          </Text>
        </Box>
      </Box>

      {/* Main Content: Modal Overlay OR 3-Pane View */}
      {activeModal === "model" && (
        <Box marginY={1} justifyContent="center">
          <ModelModal
            currentProvider={config.provider}
            currentModel={config.model}
            onSelect={handleSelectModel}
            onClose={() => setActiveModal("none")}
          />
        </Box>
      )}

      {activeModal === "fleet" && (
        <Box marginY={1} justifyContent="center">
          <FleetModal
            activeAgents={activeAgentIds}
            installedAgents={installedAgentIds}
            totalCatalogCount={fleet.totalCatalog}
            onDeploy={handleDeployAgent}
            onClose={() => setActiveModal("none")}
          />
        </Box>
      )}

      {activeModal === "tools" && (
        <Box marginY={1} justifyContent="center">
          <ToolsModal
            toolsets={config.toolsets}
            disabledToolsets={config.disabled_toolsets}
            onToggle={handleToggleToolset}
            onClose={() => setActiveModal("none")}
          />
        </Box>
      )}

      {activeModal === "doctor" && doctorReport && (
        <Box marginY={1} justifyContent="center">
          <DoctorModal
            report={doctorReport}
            onFix={async () => {
              // The same fixes `trent doctor --fix` runs; the report is the post-fix re-run.
              const { newReport } = await new FixRunner(configManager).runFixes();
              setDoctorReport(newReport);
            }}
            onClose={() => setActiveModal("none")}
          />
        </Box>
      )}

      {activeModal === "help" && (
        <Box marginY={1} justifyContent="center">
          <HelpModal onClose={() => setActiveModal("none")} />
        </Box>
      )}

      {activeModal === "none" && (
        <Box flexDirection="row" marginTop={1}>
          <Sidebar
            fleet={fleet}
            budgetSpentCents={budget.spentCents}
            budgetCapCents={budget.capCents}
            budgetWarning={budget.warning}
            toolsCount={config.toolsets.length}
            skillsCount={config.disabled_toolsets.length}
          />
          <Chat
            session={session}
            onSendMessage={handleSendMessage}
            isActive={activeModal === "none" && !busy}
          />
          <Activity
            activities={activities}
            approvals={pending}
            onApprove={approve}
            onDeny={deny}
          />
        </Box>
      )}
    </Box>
  );
};
