"use client";

/**
 * MCP Servers panel (§3.3) — the "Add MCP server" card in Integrations.
 * A client connects a remote MCP endpoint or approved local MCP preset (URL +
 * auth token, stored encrypted); Trent discovers its tools and exposes them to
 * the seats through the adapter registry. EVERY MCP tool defaults to
 * requires-approval until the client explicitly marks it reversible.
 */

import { useCallback, useEffect, useState } from "react";
import {
  McpActivityTimeline,
  McpConnectorGallery,
  McpInventorySearch,
  McpServerCommandCenterCard,
  type McpActivityItem,
  type McpPanelServer,
  type ProofAction,
} from "@/components/mcp-marketplace-sections";
import {
  type McpConnectorGrantMode,
  type McpConnectorTemplate,
} from "@/lib/mcp-connector-catalog";
import type { McpApprovalPolicy } from "@/lib/mcp-policy";
import { buildMcpToolInventory, searchMcpToolInventory } from "@/lib/mcp-tool-index";

export { McpConnectorGallery, McpServerCommandCenterCard } from "@/components/mcp-marketplace-sections";

type McpTransport = "http" | "sse" | "stdio";

const emptyDraft = {
  name: "",
  url: "",
  transport: "http" as McpTransport,
  token: "",
  grantMode: "bearer_token" as McpConnectorGrantMode,
};

export function McpServersPanel({ companyId }: { companyId: string }) {
  const [servers, setServers] = useState<McpPanelServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [proofing, setProofing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [inventoryQuery, setInventoryQuery] = useState("");
  const [proofActivity, setProofActivity] = useState<McpActivityItem[]>([]);
  const [auditActivity, setAuditActivity] = useState<McpActivityItem[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/companies/${companyId}/mcp-servers`);
    const data = await res.json().catch(() => ({}));
    setServers(data.servers ?? []);
    setLoading(false);
  }, [companyId]);

  const loadActivity = useCallback(async () => {
    const res = await fetch(`/api/audit?companyId=${companyId}`).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json().catch(() => ({}));
    setAuditActivity(parseMcpAuditActivity(data.auditLogs ?? []));
  }, [companyId]);

  useEffect(() => { void load(); void loadActivity(); }, [load, loadActivity]);

  const inventory = buildMcpToolInventory(servers.map((server) => ({ ...server, companyId })));
  const visibleInventory = searchMcpToolInventory(inventory, inventoryQuery).slice(0, 18);
  const activity = [...proofActivity, ...auditActivity].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);

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
      body: JSON.stringify({ ...draft, token: draft.grantMode === "bearer_token" || draft.grantMode === "local_stdio" ? draft.token : "" }),
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
    await loadActivity();
  }

  async function runProof(server: McpPanelServer, action: ProofAction) {
    setProofing(`${server.id}:${action}`);
    const startedAt = Date.now();
    const res = await fetch(`/api/companies/${companyId}/mcp-servers/${server.id}/proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => ({}));
    const proof = data.proof ?? {};
    const status: McpActivityItem["status"] = res.ok ? "passed" : "failed";
    setProofActivity((items) => [{
      id: `${server.id}:${action}:${Date.now()}`,
      serverId: server.id,
      action,
      summary: String(proof.evidence ?? proof.error ?? `${server.name} ${action}`),
      status,
      latencyMs: typeof proof.latencyMs === "number" ? proof.latencyMs : Date.now() - startedAt,
      createdAt: new Date().toISOString(),
    }, ...items].slice(0, 12));
    setProofing(null);
    await load();
    await loadActivity();
  }

  async function setPolicy(server: McpPanelServer, tool: string, policy: McpApprovalPolicy) {
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
      grantMode: template.grantMode,
    });
    setAdding(true);
    setError("");
  }

  async function toggleEnabled(server: McpPanelServer) {
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

      <McpInventorySearch
        query={inventoryQuery}
        onQueryChange={setInventoryQuery}
        items={visibleInventory}
        total={inventory.length}
      />

      <McpActivityTimeline items={activity} />

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
          <select
            className="input"
            data-testid="mcp-grant-mode-select"
            value={draft.grantMode}
            onChange={(e) => setDraft({ ...draft, grantMode: e.target.value as McpConnectorGrantMode })}
          >
            <option value="oauth_user">OAuth / per-user grant</option>
            <option value="bearer_token">Bearer token</option>
            <option value="provider_url">Provider-issued URL</option>
            <option value="local_stdio">Local stdio credential</option>
            <option value="none">No credential</option>
          </select>
          {(draft.grantMode === "bearer_token" || draft.grantMode === "local_stdio") ? (
            <input
              className="input"
              type="password"
              data-testid="mcp-token-input"
              placeholder="Token or provider-issued credential (stored encrypted)"
              value={draft.token}
              onChange={(e) => setDraft({ ...draft, token: e.target.value })}
            />
          ) : (
            <div data-testid="mcp-oauth-grant-note" style={{ border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: 10, color: "var(--haze)", fontSize: 11, lineHeight: 1.45 }}>
              {draft.grantMode === "oauth_user"
                ? "OAuth/per-user grants are modeled here so every user can own their own connector consent. Hosted OAuth handshake is the next implementation step; this server will remain credential-pending until a grant is completed."
                : draft.grantMode === "provider_url"
                  ? "Paste the provider-issued MCP URL above. Trent stores no raw user password for this grant mode."
                  : "This connector is read-only or public; no credential will be stored."}
            </div>
          )}
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
              onProof={(action) => runProof(server, action)}
              proofing={proofing?.startsWith(`${server.id}:`) ? proofing.split(":")[1] as ProofAction : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function parseMcpAuditActivity(logs: Array<Record<string, unknown>>): McpActivityItem[] {
  return logs
    .filter((log) => typeof log.action === "string" && log.action.startsWith("mcp."))
    .slice(0, 20)
    .map((log) => {
      const summary = typeof log.summary === "string" ? log.summary : "";
      const latencyMatch = summary.match(/latencyMs=(\d+)/) ?? summary.match(/in (\d+)ms/);
      const status: McpActivityItem["status"] =
        String(log.action).includes("failed") || summary.toLowerCase().includes("failed")
          ? "failed"
          : String(log.action).includes("approval")
            ? "needs_approval"
            : "recorded";
      return {
        id: String(log.id ?? `${log.action}:${log.createdAt}`),
        serverId: typeof log.objectId === "string" ? log.objectId : undefined,
        action: String(log.action),
        summary,
        status,
        latencyMs: latencyMatch ? Number(latencyMatch[1]) : undefined,
        createdAt: typeof log.createdAt === "string" ? log.createdAt : new Date().toISOString(),
      };
    });
}
