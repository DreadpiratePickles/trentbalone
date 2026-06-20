"use client";

import React from "react";
import {
  MCP_CONNECTOR_GALLERY,
  MCP_MARKETPLACE_SOURCES,
  mcpConnectorGrantLabel,
  type McpConnectorTemplate,
} from "@/lib/mcp-connector-catalog";
import {
  MCP_APPROVAL_POLICIES,
  classifyMcpToolPolicyClasses,
  mcpApprovalPolicyLabel,
  mcpPolicyClassLabel,
  mcpToolRiskLabel,
  type McpApprovalPolicies,
  type McpApprovalPolicy,
} from "@/lib/mcp-policy";
import { buildMcpToolInventory } from "@/lib/mcp-tool-index";

export type ProofAction = "test_read" | "test_write_dry_run" | "reapprove_changed_tools";

export type McpActivityItem = {
  id: string;
  serverId?: string;
  action: string;
  summary: string;
  status: "passed" | "failed" | "needs_approval" | "recorded";
  latencyMs?: number;
  createdAt: string;
  runLink?: string;
};

export type McpPanelServer = {
  id: string;
  companyId?: string;
  name: string;
  url: string;
  transport: "http" | "sse" | "stdio";
  hasCredential: boolean;
  toolAllowlist: string[];
  reversibleTools: string[];
  approvalPolicies: McpApprovalPolicies;
  status: string;
  lastError?: string;
  discoveredTools: Array<{
    name: string;
    title?: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    descriptionHash?: string;
  }>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export function McpConnectorGallery({ onSelect }: { onSelect: (template: McpConnectorTemplate) => void }) {
  return (
    <div data-testid="mcp-connector-gallery" style={{ display: "grid", gap: 12, marginTop: 14 }}>
      {MCP_MARKETPLACE_SOURCES.map((source) => {
        const templates = MCP_CONNECTOR_GALLERY.filter((template) => template.source === source.source);
        if (!templates.length) return null;
        return (
          <section key={source.source} data-testid={`mcp-marketplace-${source.source}`} style={{ border: "1px solid rgba(255,255,255,.06)", borderRadius: 10, padding: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", marginBottom: 8 }}>
              <div>
                <div className="mono" style={{ color: "var(--pulse)", fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase" }}>{source.label}</div>
                <div style={{ color: "var(--haze)", fontSize: 11, lineHeight: 1.4 }}>{source.description}</div>
              </div>
              <span className="mono" style={{ color: "var(--haze)", fontSize: 9 }}>{templates.length} connector{templates.length === 1 ? "" : "s"}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => onSelect(template)}
                  style={{ textAlign: "left", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: 12, background: "rgba(255,255,255,.025)", cursor: "pointer" }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ color: "var(--bone)", fontSize: 13 }}>{template.name}</strong>
                    <span className="mono" style={{ color: "var(--pulse)", fontSize: 9 }}>trust {template.trustScore}</span>
                  </div>
                  <div style={{ color: "var(--haze)", fontSize: 11, lineHeight: 1.4, marginTop: 5 }}>{template.description}</div>
                  <div className="mono" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, color: "var(--haze)", fontSize: 9 }}>
                    <span>{authLabel(template.authMode)}</span>
                    <span>{mcpConnectorGrantLabel(template.grantMode)}</span>
                    {template.supportsResources && <span>resources</span>}
                    {template.supportsPrompts && <span>prompts</span>}
                    {template.supportsAppsUi && <span>apps/ui ready</span>}
                    <span>{template.riskTier} risk</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function McpInventorySearch(props: {
  query: string;
  onQueryChange: (query: string) => void;
  items: ReturnType<typeof buildMcpToolInventory>;
  total: number;
}) {
  return (
    <section data-testid="mcp-tool-inventory" style={{ border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: 12, marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div>
          <div className="mono" style={{ color: "var(--pulse)", fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase" }}>Tool inventory</div>
          <div style={{ color: "var(--haze)", fontSize: 11 }}>Search owner, risk, schema, approval policy, last proof, and why a tool is available.</div>
        </div>
        <span className="mono" style={{ color: "var(--haze)", fontSize: 9 }}>{props.total} indexed</span>
      </div>
      <input
        className="input"
        data-testid="mcp-tool-inventory-search"
        placeholder="Search tools — e.g. refunds, read-only, customer, deploy"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        style={{ marginBottom: 10 }}
      />
      {props.items.length === 0 ? (
        <div style={{ color: "var(--haze)", fontSize: 11 }}>No tools discovered yet. Connect a server and run Discover or Test read.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {props.items.map((item) => (
            <div key={item.id} data-testid={`mcp-inventory-${item.serverId}-${item.toolName}`} style={{ border: "1px solid rgba(255,255,255,.06)", borderRadius: 8, padding: 10 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <strong style={{ color: "var(--bone)", fontSize: 12 }}>{item.adapterName}.{item.toolName}</strong>
                <span className="mono" style={{ color: item.available ? "var(--pulse)" : "var(--haze)", fontSize: 9 }}>{item.available ? "available" : "not available"}</span>
                <span className="mono" style={{ color: item.risk === "critical" ? "var(--ember)" : item.risk === "low" ? "var(--pulse)" : "var(--mist)", fontSize: 9 }}>{item.risk} risk</span>
                <span className="mono" style={{ color: "var(--haze)", fontSize: 9 }}>{item.owner}</span>
                <span className="mono" style={{ color: "var(--haze)", fontSize: 9 }}>{item.schema.input}/{item.schema.output} schema</span>
              </div>
              <div style={{ color: "var(--haze)", fontSize: 11, lineHeight: 1.4, marginTop: 6 }}>{item.whyAvailable}</div>
              <div className="mono" style={{ color: "var(--haze)", fontSize: 9, marginTop: 6 }}>proof: {item.lastProof.status} · {item.lastProof.summary}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function McpActivityTimeline({ items }: { items: McpActivityItem[] }) {
  return (
    <section data-testid="mcp-activity-timeline" style={{ border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: 12, marginTop: 14 }}>
      <div className="mono" style={{ color: "var(--pulse)", fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase" }}>MCP activity timeline</div>
      <div style={{ color: "var(--haze)", fontSize: 11, lineHeight: 1.4, marginTop: 4 }}>
        Request, approval, response, latency, evidence, and run links appear here from proof actions and MCP audit rows.
      </div>
      {items.length === 0 ? (
        <div style={{ color: "var(--haze)", fontSize: 11, marginTop: 10 }}>No MCP proof or call activity recorded yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 7, marginTop: 10 }}>
          {items.map((item) => (
            <div key={item.id} style={{ borderLeft: "2px solid rgba(110,231,183,.28)", paddingLeft: 10 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <strong style={{ color: "var(--bone)", fontSize: 12 }}>{item.action}</strong>
                <span className="mono" style={{ color: item.status === "failed" ? "var(--ember)" : "var(--pulse)", fontSize: 9 }}>{item.status}</span>
                {typeof item.latencyMs === "number" && <span className="mono" style={{ color: "var(--haze)", fontSize: 9 }}>{item.latencyMs}ms</span>}
                <span className="mono" style={{ color: "var(--haze)", fontSize: 9 }}>{new Date(item.createdAt).toLocaleString()}</span>
              </div>
              <div style={{ color: "var(--haze)", fontSize: 11, lineHeight: 1.4, marginTop: 3 }}>{item.summary}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function McpServerCommandCenterCard(props: {
  server: McpPanelServer;
  discovering: boolean;
  onDiscover: () => void;
  onToggleEnabled: () => void;
  onRemove: () => void;
  onPolicyChange: (tool: string, policy: McpApprovalPolicy) => void;
  onProof: (action: ProofAction) => void;
  proofing: ProofAction | null;
}) {
  const { server } = props;
  return (
    <div data-testid={`mcp-server-row-${server.id}`} style={{ border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, padding: "14px 16px", opacity: server.enabled ? 1 : 0.55 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--bone)" }}>{server.name}</div>
          <div className="mono" style={{ fontSize: 9, color: "var(--haze)", marginTop: 2 }}>Connector Command Center</div>
        </div>
        <StatusPill id={server.id} status={server.status} />
        <span className="mono" style={{ fontSize: 10, color: "var(--haze)" }}>{server.url}</span>
        {server.hasCredential && <span className="mono" style={{ fontSize: 9, color: "var(--haze)" }}>credential stored</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="btn btn-secondary btn-mono" data-testid={`mcp-discover-${server.id}`} style={{ height: 26, padding: "0 10px", fontSize: 9 }} onClick={props.onDiscover} disabled={props.discovering}>
            {props.discovering ? "discovering…" : "discover"}
          </button>
          <button className="btn btn-secondary btn-mono" style={{ height: 26, padding: "0 10px", fontSize: 9 }} onClick={props.onToggleEnabled}>
            {server.enabled ? "on" : "off"}
          </button>
          <button className="btn btn-secondary btn-mono" data-testid={`mcp-delete-${server.id}`} style={{ height: 26, padding: "0 10px", fontSize: 9, color: "var(--ember)", borderColor: "rgba(251,146,60,.2)" }} onClick={props.onRemove}>
            remove
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
        <ProofButton id={server.id} label="test read" busyLabel="testing…" action="test_read" proofing={props.proofing} onProof={props.onProof} />
        <ProofButton id={server.id} label="test write dry-run" busyLabel="classifying…" action="test_write_dry_run" proofing={props.proofing} onProof={props.onProof} />
        <ProofButton id={server.id} label="re-approve changed tools" busyLabel="re-approving…" action="reapprove_changed_tools" proofing={props.proofing} onProof={props.onProof} />
      </div>

      {server.lastError && <div style={{ fontSize: 11, color: "var(--ember)", marginTop: 8 }}>{server.lastError}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginTop: 12 }}>
        <Metric label="tools" value={String(server.discoveredTools.length)} />
        <Metric label="resources" value="ready" />
        <Metric label="prompts" value="ready" />
        <Metric label="credential" value={server.hasCredential ? "stored" : "grant pending"} />
      </div>

      {server.discoveredTools.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {server.discoveredTools.map((tool) => {
            const policy = server.approvalPolicies?.[tool.name] ?? (server.reversibleTools.includes(tool.name) ? "read_only_auto" : "approve_once");
            const policyClasses = classifyMcpToolPolicyClasses(tool);
            return (
              <div key={tool.name} data-testid={`mcp-tool-${server.id}-${tool.name}`} style={{ border: "1px solid rgba(255,255,255,.06)", borderRadius: 8, padding: 10 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ color: "var(--bone)", fontSize: 12 }}>{tool.title ?? tool.name}</strong>
                  <span className="mono" style={{ color: "var(--haze)", fontSize: 9 }}>{tool.name}</span>
                  <span className="mono" style={{ color: mcpToolRiskLabel(policyClasses) === "critical" ? "var(--ember)" : "var(--haze)", fontSize: 9 }}>{mcpToolRiskLabel(policyClasses)} risk</span>
                  <select className="input mono" value={policy} onChange={(event) => props.onPolicyChange(tool.name, event.target.value as McpApprovalPolicy)} style={{ marginLeft: "auto", minWidth: 150, height: 28, fontSize: 10 }}>
                    {MCP_APPROVAL_POLICIES.map((option) => <option key={option} value={option}>{mcpApprovalPolicyLabel(option)}</option>)}
                  </select>
                </div>
                {tool.description && <div style={{ color: "var(--haze)", fontSize: 11, lineHeight: 1.45, marginTop: 6 }}>{tool.description}</div>}
                <div className="mono" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8, color: "var(--haze)", fontSize: 9 }}>
                  {tool.inputSchema && <span>input schema</span>}
                  {tool.outputSchema && <span>output schema</span>}
                  {tool.annotations?.readOnlyHint === true && <span>read-only hint</span>}
                  {tool.annotations?.destructiveHint === true && <span>destructive hint</span>}
                  {policyClasses.map((item) => <span key={item}>{mcpPolicyClassLabel(item)}</span>)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProofButton(props: {
  id: string;
  label: string;
  busyLabel: string;
  action: ProofAction;
  proofing: ProofAction | null;
  onProof: (action: ProofAction) => void;
}) {
  return (
    <button className="btn btn-secondary btn-mono" data-testid={`mcp-${props.action.replace(/_/g, "-")}-${props.id}`} style={{ height: 26, padding: "0 10px", fontSize: 9 }} onClick={() => props.onProof(props.action)} disabled={props.proofing === props.action}>
      {props.proofing === props.action ? props.busyLabel : props.label}
    </button>
  );
}

function StatusPill({ id, status }: { id: string; status: string }) {
  return (
    <span
      className="mono"
      data-testid={`mcp-server-status-${id}`}
      style={{
        fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 99,
        color: status === "connected" ? "var(--pulse)" : status === "error" ? "var(--ember)" : "var(--haze)",
        border: `1px solid ${status === "connected" ? "rgba(110,231,183,.25)" : status === "error" ? "rgba(251,146,60,.25)" : "rgba(255,255,255,.1)"}`,
      }}
    >
      {status}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,.06)", borderRadius: 8, padding: "8px 10px" }}>
      <div className="mono" style={{ color: "var(--haze)", fontSize: 8, letterSpacing: ".1em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ color: "var(--bone)", fontSize: 12, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function authLabel(mode: McpConnectorTemplate["authMode"]): string {
  if (mode === "oauth") return "OAuth";
  if (mode === "provider_url") return "provider URL";
  if (mode === "none") return "no auth";
  return "token";
}
