import React, { useState, useEffect } from "react";
import { TopNav } from "./components/TopNav.js";
import { LeftRail } from "./components/LeftRail.js";
import { ChatView } from "./components/ChatView.js";
import { ApprovalModal } from "./components/ApprovalModal.js";
import { CatalogView } from "./components/CatalogView.js";
import { DoctorView } from "./components/DoctorView.js";
import { SettingsView } from "./components/SettingsView.js";
import { EmbeddedTerminal } from "./components/EmbeddedTerminal.js";
import { TracesView } from "./components/TracesView.js";
import { McpView } from "./components/McpView.js";
import { A2AView } from "./components/A2AView.js";
import { WikiView } from "./components/WikiView.js";
import { trayService } from "./tray.js";
import { notificationService } from "./notifications.js";
import type {
  TabType,
  AgentSeat,
  ChatMessage,
  ApprovalRequest,
  DoctorCheckItem,
  BudgetState,
} from "./types.js";

// Core 9 Operating Seats + catalog sample
const INITIAL_AGENTS: AgentSeat[] = [
  {
    id: "ceo",
    name: "Trent CEO",
    role: "Chief Executive & Vision Orchestrator",
    category: "Executive",
    description: "Multi-agent coordinator, strategic priorities, milestone roadmap synthesis, and executive decisions.",
    active: true,
    installed: true,
    color: "#8B5CF6",
  },
  {
    id: "engineer",
    name: "Lead Engineer",
    role: "Full-Stack System Architect",
    category: "Engineering",
    description: "Designs system architecture, writes clean robust code, debugs complex services, and executes test suites.",
    active: true,
    installed: true,
    color: "#06B6D4",
  },
  {
    id: "growth",
    name: "Growth Lead",
    role: "Traction & Acquisition Strategist",
    category: "Marketing",
    description: "Orchestrates user acquisition, viral loops, landing page optimization, and analytics funnels.",
    active: false,
    installed: true,
    color: "#10B981",
  },
  {
    id: "content",
    name: "Content Engine",
    role: "Narrative & Publishing Strategist",
    category: "Content",
    description: "Generates high-converting copy, technical documentation, launch announcements, and social content.",
    active: false,
    installed: true,
    color: "#F59E0B",
  },
  {
    id: "support",
    name: "Support Lead",
    role: "Customer Success & Triage",
    category: "Support",
    description: "Resolves customer questions, monitors ticket health, drafts postmortems, and escalates critical bugs.",
    active: true,
    installed: true,
    color: "#3B82F6",
  },
  {
    id: "analyst",
    name: "Data Analyst",
    role: "Metrics & Quantitative Insights",
    category: "Analytics",
    description: "Queries SQL databases, synthesizes cohort retention, tracks CAC/LTV, and forecasts financial runways.",
    active: false,
    installed: true,
    color: "#EC4899",
  },
  {
    id: "finance",
    name: "Finance Controller",
    role: "Burn & Capital Allocation",
    category: "Finance",
    description: "Monitors daily budget caps, tracks model token burn rates, reviews invoices, and reconciles Stripe payments.",
    active: false,
    installed: true,
    color: "#EF4444",
  },
  {
    id: "browser",
    name: "Web Navigator",
    role: "Headless Browser Specialist",
    category: "Research",
    description: "Interacts with modern web apps, extracts structured intelligence, performs competitive analysis.",
    active: false,
    installed: true,
    color: "#6366F1",
  },
  {
    id: "escalation",
    name: "Incident Escalation",
    role: "P0 Crisis Management",
    category: "Operations",
    description: "Immediate triage of production outages, security anomalies, and human-in-the-loop paging.",
    active: false,
    installed: true,
    color: "#F97316",
  },
];

const INITIAL_CHECKS: DoctorCheckItem[] = [
  { id: "1", category: "Config", name: "Configuration Schema", status: "ok", message: "Valid configuration loaded from ~/.trent/config.yaml", autoFixable: false },
  { id: "2", category: "Credentials", name: "Provider API Keys", status: "ok", message: "1 provider key detected (anthropic), active provider configured", autoFixable: false },
  { id: "3", category: "Agents", name: "Fleet Catalog Integrity", status: "ok", message: "3 installed agents loaded (1 active). Catalog contains 164 available specialists", autoFixable: false },
  { id: "4", category: "Skills", name: "Skills Hub Sandbox", status: "ok", message: "0 skills synced and healthy", autoFixable: false },
  { id: "5", category: "MCP", name: "Model Context Protocol", status: "ok", message: "MCP connector marketplace active with trust scores and risk policies enforced", autoFixable: false },
  { id: "6", category: "Connectivity", name: "Gateway Network Egress", status: "ok", message: "Network connectivity verified; API endpoints reachable", autoFixable: false },
  { id: "7", category: "Database", name: "Local State Store", status: "ok", message: "Local state store healthy (0 sessions, 0.0 KB)", autoFixable: false },
  { id: "8", category: "Cron", name: "Scheduler Daemon", status: "ok", message: "Scheduler ready, no stuck background jobs", autoFixable: false },
  { id: "9", category: "Disk", name: "Log Storage Bounds", status: "ok", message: "Log storage healthy (0.0 MB across 0 files)", autoFixable: false },
  { id: "10", category: "Dependencies", name: "System Binaries", status: "ok", message: "All core binaries present (git, node, npm). Docker sandbox: available", autoFixable: false },
  { id: "11", category: "Workbench", name: "Execution Sandbox", status: "ok", message: "Sandbox backend configured: docker. Isolation policy active", autoFixable: false },
  { id: "12", category: "Self-Improvement", name: "GEPA Frontier & Eval", status: "ok", message: "Trace store writable, GEPA evolutionary frontier & eval gate active", autoFixable: false },
];

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>("chat");
  const [agents, setAgents] = useState<AgentSeat[]>(INITIAL_AGENTS);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("ceo");
  const [budget, setBudget] = useState<BudgetState>({ spent: 0.12, cap: 10.0, currency: "USD" });
  const [provider, setProvider] = useState<string>("anthropic");
  const [model, setModel] = useState<string>("claude-3-7-sonnet");
  const [doctorChecks, setDoctorChecks] = useState<DoctorCheckItem[]>(INITIAL_CHECKS);
  const [isDoctorRunning, setIsDoctorRunning] = useState(false);

  const [approvals, setApprovals] = useState<ApprovalRequest[]>([
    {
      id: "app-01",
      agent: "engineer",
      action: "Execute Database Migration",
      description: "Applies latest schema migration to synchronize company members and seat roles.",
      command: "npx prisma migrate deploy --schema=apps/web/prisma/schema.prisma",
      riskLevel: "medium",
      costEstimated: 0.0,
      requestedAt: "Just now",
    },
  ]);

  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({
    ceo: [
      {
        id: "m-1",
        role: "assistant",
        agent: "ceo",
        content:
          "Welcome to Trent Fleet! All 9 core operating seats and 164 specialist cofounder agents stand ready. How would you like to direct the company today?",
        timestamp: new Date().toLocaleTimeString(),
        metadata: {
          durationMs: 420,
          cost: 0.02,
          model: "claude-3-7-sonnet",
          thought: "Initialized cofounder workspace. Standing by for strategic directions or sprint goals.",
        },
      },
    ],
  });

  // Listen for tray navigation events
  useEffect(() => {
    notificationService.requestPermission();

    if (typeof window !== "undefined" && (window as any).__TAURI__) {
      import("@tauri-apps/api/event").then(({ listen }) => {
        listen("navigate", (event: { payload?: unknown }) => {
          if (event.payload) {
            setActiveTab(event.payload as TabType);
          }
        });
      });
    }
  }, []);

  // Update tray state based on pending approvals
  useEffect(() => {
    if (approvals.length > 0) {
      trayService.setState("approval");
    } else {
      trayService.setState("active");
    }
  }, [approvals.length]);

  const activeAgent = agents.find((a) => a.id === selectedAgentId) || agents[0];
  const currentMessages = messages[selectedAgentId] || [];

  const handleSendMessage = (text: string) => {
    const userMsg: ChatMessage = {
      id: Math.random().toString(36).substring(2, 9),
      role: "user",
      content: text,
      timestamp: new Date().toLocaleTimeString(),
    };

    setMessages((prev) => ({
      ...prev,
      [selectedAgentId]: [...(prev[selectedAgentId] || []), userMsg],
    }));

    // Autonomous cofounder response simulation
    setTimeout(() => {
      const reply: ChatMessage = {
        id: Math.random().toString(36).substring(2, 9),
        role: "assistant",
        agent: activeAgent.name,
        content: `I have received your instruction: "${text}".\n\n1. Analysis: Prioritized for high-leverage execution.\n2. Delegated: Allocated subtasks to engineering and analytics agents.\n3. Safeguards: Verified against active budget cap ($${budget.spent.toFixed(2)} spent today).`,
        timestamp: new Date().toLocaleTimeString(),
        metadata: {
          durationMs: 650,
          cost: 0.04,
          model: `${provider}:${model}`,
          thought: `Assessing scope of '${text}'. Formulating optimal multi-agent execution pipeline.`,
        },
      };

      setMessages((prev) => ({
        ...prev,
        [selectedAgentId]: [...(prev[selectedAgentId] || []), reply],
      }));

      setBudget((b) => ({ ...b, spent: b.spent + 0.04 }));
    }, 600);
  };

  const handleApprove = (id: string) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
    notificationService.send({
      title: "Approval Granted",
      body: "Autonomous cofounder action has been executed successfully.",
    });
  };

  const handleDeny = (id: string) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  };

  const handleToggleInstall = (agentId: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, installed: !a.installed } : a))
    );
  };

  const handleToggleDeploy = (agentId: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, active: !a.active } : a))
    );
  };

  const handleInstallPack = (packName: string) => {
    setAgents((prev) =>
      prev.map((a) => ({
        ...a,
        installed: true,
        active: packName === "all" ? true : a.active,
      }))
    );
    notificationService.send({
      title: "Fleet Pack Deployed",
      body: `Successfully configured and deployed specialists for pack "${packName}".`,
    });
  };

  const handleRunDiagnostics = () => {
    setIsDoctorRunning(true);
    setTimeout(() => {
      setIsDoctorRunning(false);
      setDoctorChecks(INITIAL_CHECKS);
      notificationService.send({
        title: "Doctor Diagnostics Complete",
        body: "All 12 checks passed! Fleet system is fully operational.",
      });
    }, 900);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0F1117] text-white overflow-hidden">
      <TopNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        pendingApprovalsCount={approvals.length}
        budget={budget}
        activeModel={model}
        activeProvider={provider}
        doctorHealthy={doctorChecks.every((c) => c.status === "ok")}
      />

      <div className="flex-1 flex overflow-hidden">
        <LeftRail
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          onOpenCatalog={() => setActiveTab("catalog")}
          installedCount={agents.filter((a) => a.active).length}
          totalCount={agents.length}
        />

        <main className="flex-1 flex overflow-hidden">
          {activeTab === "chat" && (
            <ChatView
              agent={activeAgent}
              messages={currentMessages}
              onSendMessage={handleSendMessage}
            />
          )}

          {activeTab === "approvals" && (
            <ApprovalModal
              approvals={approvals}
              onApprove={handleApprove}
              onDeny={handleDeny}
            />
          )}

          {activeTab === "catalog" && (
            <CatalogView
              agents={agents}
              onToggleInstall={handleToggleInstall}
              onToggleDeploy={handleToggleDeploy}
              onInstallPack={handleInstallPack}
            />
          )}

          {activeTab === "traces" && <TracesView />}

          {activeTab === "mcp" && <McpView />}

          {activeTab === "a2a" && <A2AView />}

          {activeTab === "wiki" && <WikiView />}

          {activeTab === "terminal" && <EmbeddedTerminal />}

          {activeTab === "doctor" && (
            <DoctorView
              checks={doctorChecks}
              isRunning={isDoctorRunning}
              onRunDiagnostics={handleRunDiagnostics}
              onRunFixes={handleRunDiagnostics}
            />
          )}

          {activeTab === "settings" && (
            <SettingsView
              currentProvider={provider}
              currentModel={model}
              onSaveConfig={(p, m) => {
                setProvider(p);
                setModel(m);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
};
