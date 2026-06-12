"use client";

import { useCallback, useEffect, useState } from "react";
import type React from "react";

type McpServer = {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  toolAllowlist: string[];
  reversibleTools: string[];
  discoveredTools: Array<{ name: string; description?: string }>;
};

export function McpToolVisibilityPanel({ companyId, compact = false }: { companyId: string; compact?: boolean }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/companies/${companyId}/mcp-servers`);
    const data = await res.json().catch(() => ({}));
    setServers(data.servers ?? []);
    setLoading(false);
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  const enabled = servers.filter((server) => server.enabled);
  const connectedTools = enabled.flatMap((server) => {
    const discovered = server.discoveredTools.length
      ? server.discoveredTools
      : server.toolAllowlist.map((name) => ({ name }));
    return discovered.map((tool) => ({
      server,
      toolName: tool.name,
      reversible: server.reversibleTools.includes(tool.name),
      allowed: server.toolAllowlist.length === 0 || server.toolAllowlist.includes(tool.name),
    }));
  });

  return (
    <section data-testid="mcp-tool-visibility-panel" style={S.panel(compact)}>
      <div style={S.head}>
        <span className="mono" style={S.kicker}>MCP tools</span>
        <span className="mono" style={S.count}>{loading ? "loading" : `${connectedTools.length} tools`}</span>
      </div>
      {loading ? (
        <div style={S.empty}>Checking MCP tool access...</div>
      ) : connectedTools.length === 0 ? (
        <div style={S.empty}>No MCP tools configured.</div>
      ) : (
        <div style={S.list}>
          {connectedTools.slice(0, compact ? 4 : 12).map((item) => (
            <div key={`${item.server.id}:${item.toolName}`} style={S.row}>
              <span style={S.tool}>{adapterName(item.server.name)}.{item.toolName}</span>
              <span style={S.badge(item.reversible, item.allowed)}>
                {!item.allowed ? "not allowed" : item.reversible ? "reversible" : "approval required"}
              </span>
            </div>
          ))}
          {compact && connectedTools.length > 4 ? (
            <div style={S.empty}>+{connectedTools.length - 4} more MCP tools</div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function adapterName(serverName: string): string {
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `mcp_${slug || "server"}`;
}

const border = "1px solid rgba(255,255,255,.07)";

const S = {
  panel: (compact: boolean) => ({
    margin: compact ? "8px 14px 0" : "16px 0",
    padding: compact ? "9px 10px" : "12px 14px",
    border,
    borderRadius: 8,
    background: "rgba(255,255,255,.018)",
  }) as React.CSSProperties,
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 7 } as React.CSSProperties,
  kicker: { fontSize: 9, letterSpacing: ".16em", color: "var(--haze)" } as React.CSSProperties,
  count: { fontSize: 9, color: "var(--mist)" } as React.CSSProperties,
  empty: { fontSize: 11, color: "var(--haze)", lineHeight: 1.4 } as React.CSSProperties,
  list: { display: "grid", gap: 5 } as React.CSSProperties,
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 } as React.CSSProperties,
  tool: { fontSize: 11, color: "var(--mist)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  badge: (reversible: boolean, allowed: boolean) => ({
    flexShrink: 0,
    borderRadius: 999,
    padding: "2px 6px",
    border,
    color: !allowed ? "var(--ember)" : reversible ? "var(--pulse)" : "var(--mist)",
    fontSize: 9,
    whiteSpace: "nowrap",
  }) as React.CSSProperties,
};
