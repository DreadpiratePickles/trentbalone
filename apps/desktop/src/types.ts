export type TabType =
  | "chat"
  | "approvals"
  | "catalog"
  | "traces"
  | "mcp"
  | "a2a"
  | "wiki"
  | "terminal"
  | "doctor"
  | "settings";

export interface AgentSeat {
  id: string;
  name: string;
  role: string;
  category: string;
  description: string;
  active: boolean;
  installed: boolean;
  color: string;
  avatarIcon?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  agent?: string;
  content: string;
  timestamp: string;
  metadata?: {
    file?: string;
    lines?: number;
    durationMs?: number;
    cost?: number;
    model?: string;
    thought?: string;
  };
}

export interface ApprovalRequest {
  id: string;
  agent: string;
  action: string;
  description: string;
  command?: string;
  targetFile?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  costEstimated?: number;
  requestedAt: string;
}

export interface DoctorCheckItem {
  id: string;
  category: string;
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  fixHint?: string;
  autoFixable: boolean;
}

export interface BudgetState {
  spent: number;
  cap: number;
  currency: string;
}

export interface TraceSpan {
  id: string;
  traceId: string;
  name: string;
  agent: string;
  model: string;
  durationMs: number;
  cost: number;
  tokensPrompt: number;
  tokensCompletion: number;
  timestamp: string;
  status: "ok" | "error";
  hasRedactions: boolean;
}

export interface McpConnector {
  id: string;
  name: string;
  description: string;
  transport: "http" | "sse" | "stdio";
  trustScore: number;
  riskTier: "low" | "medium" | "high";
  installed: boolean;
}

export interface AgentCardSummary {
  agentId: string;
  name: string;
  role: string;
  organization: string;
  publicKey: string;
  signature: string;
  supportedProtocols: string[];
}
