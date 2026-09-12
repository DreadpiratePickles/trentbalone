import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  ConfigManager,
  FleetManager,
  SessionManager,
  ApprovalBridge,
  DoctorRunner,
  type DoctorReport,
  type Toolset,
  type Provider,
} from "@trent/core";
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
}

export const App: React.FC<AppProps> = (props) => {
  const configManager = props.configManager || new ConfigManager();
  const fleetManager = props.fleetManager || new FleetManager(configManager);
  const sessionManager = props.sessionManager || new SessionManager(configManager);
  const approvalBridge = props.approvalBridge || new ApprovalBridge();
  const doctorRunner = new DoctorRunner(configManager);

  const fleet = useFleet(fleetManager);
  const { pending, approve, deny } = useApprovals(approvalBridge);
  const { dailySpent, dailyCap } = useBudget(configManager);
  const { session, appendUserMessage, appendAgentMessage } = useSession(sessionManager);

  const [activeModal, setActiveModal] = useState<
    "none" | "model" | "fleet" | "tools" | "doctor" | "help"
  >("none");
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);

  const config = configManager.loadConfig();

  useInput((input, key) => {
    if (activeModal !== "none") return;

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

  const [activities, setActivities] = useState<TuiActivityItem[]>([
    {
      id: "act-1",
      agent: "CEO",
      action: "Fleet initialized in 3-pane autonomous mode",
      timestamp: new Date().toISOString(),
    },
  ]);

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

    appendUserMessage(text);
    const actId = `act-${Date.now()}`;
    setActivities((prev) => [
      {
        id: actId,
        agent: "Engineer",
        action: `Processing: "${text.slice(0, 24)}..."`,
        timestamp: new Date().toISOString(),
      },
      ...prev.slice(0, 8),
    ]);

    setTimeout(() => {
      appendAgentMessage(
        "CEO",
        `Dispatching subtasks across Trent specialists for: "${text}". Fleet operational.`
      );
    }, 300);
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
        borderColor="#8B5CF6"
        paddingX={1}
        justifyContent="space-between"
      >
        <Box>
          <Text bold color="#8B5CF6">
            ⚡ TRENT FLEET{" "}
          </Text>
          <Text dimColor color="#9CA3AF">
            v1.0.0 (Hermes Parity)
          </Text>
        </Box>
        <Box>
          <Text color="#9CA3AF">Model: </Text>
          <Text bold color="#06B6D4">
            {config.model}{" "}
          </Text>
          <Text color="#9CA3AF">({config.provider})</Text>
        </Box>
        <Box>
          <Text dimColor color="#6B7280">
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
              await doctorRunner.fixAll();
              const refreshed = await doctorRunner.runAll();
              setDoctorReport(refreshed);
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
            budgetSpent={dailySpent}
            budgetCap={dailyCap}
            toolsCount={config.toolsets.length}
            skillsCount={config.disabled_toolsets.length}
          />
          <Chat
            session={session}
            onSendMessage={handleSendMessage}
            isActive={activeModal === "none"}
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
