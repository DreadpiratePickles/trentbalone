"use client";

/**
 * MCP Servers panel (§3.3) — the "Add MCP server" card in Integrations.
 * A client connects a remote MCP endpoint or approved local MCP preset (URL +
 * auth token, stored encrypted); Trent discovers its tools and exposes them to
 * the seats through the adapter registry. EVERY MCP tool defaults to
 * requires-approval until the client explicitly marks it reversible.
 */

import { useCallback, useEffect, useState } from "react";

type McpServer = {
  id: string;
  name: string;
  url: string;
  transport: McpTransport;
  hasCredential: boolean;
  toolAllowlist: string[];
  reversibleTools: string[];
  status: string;
  lastError?: string;
  discoveredTools: { name: string; description: string }[];
  enabled: boolean;
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

  async function toggleReversible(server: McpServer, tool: string) {
    const reversibleTools = server.reversibleTools.includes(tool)
      ? server.reversibleTools.filter((t) => t !== tool)
      : [...server.reversibleTools, tool];
    await fetch(`/api/companies/${companyId}/mcp-servers/${server.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reversibleTools }),
    });
    await load();
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 16, color: "var(--bone)" }}>MCP servers</div>
          <div style={{ fontSize: 12, color: "var(--haze)", marginTop: 4, lineHeight: 1.5, maxWidth: 560 }}>
            Connect a remote Model Context Protocol server or approved local preset (your CRM,
            helpdesk, data warehouse…) and Trent&apos;s agents can act in it. Every MCP tool requires
            founder approval until you explicitly mark it reversible.
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

      {adding && (
        <div data-testid="mcp-add-form" style={{ marginTop: 12, border: "1px solid rgba(110,231,183,.15)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <input
              className="input"
              data-testid="mcp-name-input"
              placeholder="Name — e.g. hubspot"
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
            placeholder="Auth token (optional — stored encrypted)"
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
            <div
              key={server.id}
              data-testid={`mcp-server-row-${server.id}`}
              style={{ border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "14px 16px", opacity: server.enabled ? 1 : 0.55 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--bone)" }}>{server.name}</div>
                <span
                  className="mono"
                  data-testid={`mcp-server-status-${server.id}`}
                  style={{
                    fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", padding: "2px 8px", borderRadius: 99,
                    color: server.status === "connected" ? "var(--pulse)" : server.status === "error" ? "var(--ember)" : "var(--haze)",
                    border: `1px solid ${server.status === "connected" ? "rgba(110,231,183,.25)" : server.status === "error" ? "rgba(251,146,60,.25)" : "rgba(255,255,255,.1)"}`,
                  }}
                >
                  {server.status}
                </span>
                <span className="mono" style={{ fontSize: 10, color: "var(--haze)" }}>{server.url}</span>
                {server.hasCredential && <span className="mono" style={{ fontSize: 9, color: "var(--haze)" }}>token ✓</span>}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button
                    className="btn btn-secondary btn-mono"
                    data-testid={`mcp-discover-${server.id}`}
                    style={{ height: 26, padding: "0 10px", fontSize: 9 }}
                    onClick={() => discover(server.id)}
                    disabled={discovering === server.id}
                  >
                    {discovering === server.id ? "discovering…" : "discover tools"}
                  </button>
                  <button
                    className="btn btn-secondary btn-mono"
                    style={{ height: 26, padding: "0 10px", fontSize: 9 }}
                    onClick={() => toggleEnabled(server)}
                  >
                    {server.enabled ? "on" : "off"}
                  </button>
                  <button
                    className="btn btn-secondary btn-mono"
                    data-testid={`mcp-delete-${server.id}`}
                    style={{ height: 26, padding: "0 10px", fontSize: 9, color: "var(--ember)", borderColor: "rgba(251,146,60,.2)" }}
                    onClick={() => remove(server.id)}
                  >
                    remove
                  </button>
                </div>
              </div>

              {server.lastError && (
                <div style={{ fontSize: 11, color: "var(--ember)", marginTop: 8 }}>{server.lastError}</div>
              )}

              {server.discoveredTools.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="mono" style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 6 }}>
                    tools · click to toggle approval policy
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {server.discoveredTools.map((tool) => {
                      const reversible = server.reversibleTools.includes(tool.name);
                      return (
                        <button
                          key={tool.name}
                          data-testid={`mcp-tool-${server.id}-${tool.name}`}
                          title={`${tool.description || tool.name} — ${reversible ? "reversible (no approval)" : "requires approval"}`}
                          onClick={() => toggleReversible(server, tool.name)}
                          className="mono"
                          style={{
                            fontSize: 10, padding: "4px 10px", borderRadius: 99, cursor: "pointer",
                            background: reversible ? "rgba(110,231,183,.06)" : "rgba(251,146,60,.05)",
                            border: `1px solid ${reversible ? "rgba(110,231,183,.25)" : "rgba(251,146,60,.2)"}`,
                            color: reversible ? "var(--pulse)" : "var(--ember)",
                          }}
                        >
                          {tool.name} {reversible ? "· auto" : "· approval"}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
