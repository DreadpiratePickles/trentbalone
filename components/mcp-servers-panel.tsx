"use client";

/**
 * MCP Servers panel (§3.3) — the "Add MCP server" card in Integrations.
 * A client connects a remote MCP endpoint or approved local MCP preset (URL +
 * auth token, stored encrypted); Trent discovers its tools and exposes them to
 * the seats through the adapter registry. EVERY MCP tool defaults to
 * requires-approval until the client explicitly marks it reversible.
 */

import React, { useCallback, useEffect, useState } from "react";
import { MCP_CONNECTOR_GALLERY, type McpConnectorTemplate } from "@/lib/mcp-connector-catalog";
import {
  MCP_APPROVAL_POLICIES,
  mcpApprovalPolicyLabel,
  type McpApprovalPolicies,
  type McpApprovalPolicy,
} from "@/lib/mcp-policy";

type McpServer = {
  id: string;
  name: string;
  url: string;
  transport: McpTransport;
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
  }>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type McpTransport = "http" | "sse" | "stdio";

const emptyDraft = { name: "", url: "", transport: "http" as McpTransport, token: "" };

export function McpServersPanel({ companyId }: { companyId: string }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/companies/${companyId}/mcp-servers`);
    const data = await res.json().catch(() => ({}));
    setServers(data.servers ?? []);
    setLoading(false);
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  async function addServer() {
    if (!draft.name.trim() || !draft.url.trim()) {
      setError("Name and URL are required.");
      return;
    }
    setSaving(true);
    setError("");
    const res = await fetch(`/api/companies/${companyId}/mcp-servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to add server.");
      return;
    }
    const data = await res.json();
    setAdding(false);
    setDraft(emptyDraft);
    await load();
    if (data.server?.id) await discover(data.server.id);
  }

  async function discover(serverId: string) {
    setDiscovering(serverId);
    await fetch(`/api/companies/${companyId}/mcp-servers/${serverId}/discover`, { method: "POST" });
    setDiscovering(null);
    await load();
  }

  async function setPolicy(server: McpServer, tool: string, policy: McpApprovalPolicy) {
    await fetch(`/api/companies/${companyId}/mcp-servers/${server.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicies: { ...server.approvalPolicies, [tool]: policy } }),
    });
    await load();
  }

  function useTemplate(template: McpConnectorTemplate) {
    setDraft({
      name: template.name,
      url: template.url,
      transport: template.transport,
      token: "",
    });
    setAdding(true);
    setError("");
  }

  async function toggleEnabled(server: McpServer) {
    await fetch(`/api/companies/${companyId}/mcp-servers/${server.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !server.enabled }),
    });
    await load();
  }

  async function remove(serverId: string) {
    await fetch(`/api/companies/${companyId}/mcp-servers/${serverId}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="card" data-testid="mcp-servers-panel" style={{ marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 16 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 16, color: "var(--bone)" }}>MCP Connector Command Center</div>
          <div style={{ fontSize: 12, color: "var(--haze)", marginTop: 4, lineHeight: 1.5, maxWidth: 560 }}>
            Connect governed MCP providers, inspect discovered schemas, set per-tool approval policy,
            and let seats load only the relevant connector tools for each task.
          </div>
        </div>
        <button
          className="btn btn-secondary btn-mono"
          data-testid="mcp-add-server-button"
          style={{ height: 30, padding: "0 12px", fontSize: 10, whiteSpace: "nowrap" }}
          onClick={() => { setAdding(true); setError(""); }}
        >
          + add mcp server
        </button>
      </div>

      <McpConnectorGallery onSelect={useTemplate} />

      {adding && (
        <div data-testid="mcp-add-form" style={{ marginTop: 12, border: "1px solid rgba(110,231,183,.15)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <input
              className="input"
              data-testid="mcp-name-input"
              placeholder="Name — e.g. GitHub"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <select
              className="input"
              data-testid="mcp-transport-select"
              value={draft.transport}
              onChange={(e) => {
                const transport = (e.target.value === "sse" || e.target.value === "stdio" ? e.target.value : "http") as McpTransport;
                setDraft({
                  ...draft,
                  transport,
                  url: transport === "stdio" && !draft.url.trim() ? "stdio://sentry" : draft.url,
                });
              }}
            >
              <option value="http">Streamable HTTP</option>
              <option value="sse">SSE (legacy)</option>
              <option value="stdio">Sentry local MCP (stdio preset)</option>
            </select>
          </div>
          <input
            className="input"
            data-testid="mcp-url-input"
            placeholder={draft.transport === "stdio" ? "Preset URL — stdio://sentry" : "Server URL — https://mcp.example.com/mcp"}
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
          />
          <input
            className="input"
            type="password"
            data-testid="mcp-token-input"
            placeholder="Token or provider-issued credential (stored encrypted)"
            value={draft.token}
            onChange={(e) => setDraft({ ...draft, token: e.target.value })}
          />
          {error && <div data-testid="mcp-add-error" style={{ fontSize: 12, color: "var(--ember)" }}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-secondary btn-mono" style={{ fontSize: 10 }} onClick={() => setAdding(false)}>cancel</button>
            <button
              className="btn btn-pulse btn-mono"
              data-testid="mcp-save-server-button"
              style={{ marginLeft: "auto", fontSize: 10 }}
              onClick={addServer}
              disabled={saving}
            >
              {saving ? "connecting…" : "connect server"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="skel" style={{ height: 60, borderRadius: 10, marginTop: 12 }} />
      ) : servers.length === 0 && !adding ? (
        <div data-testid="mcp-servers-empty" style={{ fontSize: 12, color: "var(--haze)", padding: "16px 0" }}>
          No MCP servers connected yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
          {servers.map((server) => (
            <McpServerCommandCenterCard
              key={server.id}
              server={server}
              discovering={discovering === server.id}
              onDiscover={() => discover(server.id)}
              onToggleEnabled={() => toggleEnabled(server)}
              onRemove={() => remove(server.id)}
              onPolicyChange={(tool, policy) => setPolicy(server, tool, policy)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function McpConnectorGallery({ onSelect }: { onSelect: (template: McpConnectorTemplate) => void }) {
  return (
    <div data-testid="mcp-connector-gallery" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8, marginTop: 14 }}>
      {MCP_CONNECTOR_GALLERY.map((template) => (
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
            {template.supportsResources && <span>resources</span>}
            {template.supportsPrompts && <span>prompts</span>}
            <span>{template.riskTier} risk</span>
          </div>
        </button>
      ))}
    </div>
  );
}

export function McpServerCommandCenterCard(props: {
  server: McpServer;
  discovering: boolean;
  onDiscover: () => void;
  onToggleEnabled: () => void;
  onRemove: () => void;
  onPolicyChange: (tool: string, policy: McpApprovalPolicy) => void;
}) {
  const { server } = props;
  return (
    <div
      data-testid={`mcp-server-row-${server.id}`}
      style={{ border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, padding: "14px 16px", opacity: server.enabled ? 1 : 0.55 }}
    >
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

      {server.lastError && <div style={{ fontSize: 11, color: "var(--ember)", marginTop: 8 }}>{server.lastError}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginTop: 12 }}>
        <Metric label="tools" value={String(server.discoveredTools.length)} />
        <Metric label="resources" value="ready" />
        <Metric label="prompts" value="ready" />
        <Metric label="credential" value={server.hasCredential ? "per-user ready" : "none"} />
      </div>

      {server.discoveredTools.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {server.discoveredTools.map((tool) => {
            const policy = server.approvalPolicies?.[tool.name] ?? (server.reversibleTools.includes(tool.name) ? "read_only_auto" : "approve_once");
            return (
              <div key={tool.name} data-testid={`mcp-tool-${server.id}-${tool.name}`} style={{ border: "1px solid rgba(255,255,255,.06)", borderRadius: 8, padding: 10 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ color: "var(--bone)", fontSize: 12 }}>{tool.title ?? tool.name}</strong>
                  <span className="mono" style={{ color: "var(--haze)", fontSize: 9 }}>{tool.name}</span>
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
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
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
