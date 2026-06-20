"use client";

import { useCallback, useEffect, useState } from "react";
import type React from "react";
import { buildMcpToolInventory } from "@/lib/mcp-tool-index";

type McpServer = {
  id: string;
  companyId?: string;
  name: string;
  url: string;
  transport: "http" | "sse" | "stdio";
  hasCredential: boolean;
  status: string;
  lastError?: string;
  enabled: boolean;
  toolAllowlist: string[];
  reversibleTools: string[];
  approvalPolicies: Record<string, "read_only_auto" | "approve_once" | "always_approve" | "disabled">;
  discoveredTools: Array<{
    name: string;
    title?: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    descriptionHash?: string;
  }>;
  createdAt: string;
  updatedAt: string;
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

  const tools = buildMcpToolInventory(servers.map((server) => ({ ...server, companyId })));

  return (
    <section data-testid="mcp-tool-visibility-panel" style={S.panel(compact)}>
      <div style={S.head}>
        <span className="mono" style={S.kicker}>MCP tools</span>
        <span className="mono" style={S.count}>{loading ? "loading" : `${tools.length} tools`}</span>
      </div>
      {loading ? (
        <div style={S.empty}>Checking MCP tool access...</div>
      ) : tools.length === 0 ? (
        <div style={S.empty}>No MCP tools configured.</div>
      ) : (
        <div style={S.list}>
          {tools.slice(0, compact ? 4 : 12).map((item) => (
            <div key={item.id} style={S.item} title={`${item.whyAvailable} Evidence: ${item.evidence}`}>
              <div style={S.row}>
                <span style={S.tool}>{item.adapterName}.{item.toolName}</span>
                <span style={S.badge(item.risk, item.available)}>
                  {!item.available ? "not available" : item.approvalPolicy === "read_only_auto" ? "auto read" : "approval"}
                </span>
              </div>
              {!compact && (
                <>
                  <div style={S.reason}>{item.whyAvailable}</div>
                  <div className="mono" style={S.proof}>evidence: {item.evidence}</div>
                </>
              )}
            </div>
          ))}
          {compact && tools.length > 4 ? (
            <div style={S.empty}>+{tools.length - 4} more MCP tools</div>
          ) : null}
        </div>
      )}
    </section>
  );
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
  item: { display: "grid", gap: 4, minWidth: 0 } as React.CSSProperties,
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 } as React.CSSProperties,
  tool: { fontSize: 11, color: "var(--mist)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  reason: { color: "var(--haze)", fontSize: 10, lineHeight: 1.35 } as React.CSSProperties,
  proof: { color: "var(--haze)", fontSize: 8, lineHeight: 1.35 } as React.CSSProperties,
  badge: (risk: string, allowed: boolean) => ({
    flexShrink: 0,
    borderRadius: 999,
    padding: "2px 6px",
    border,
    color: !allowed ? "var(--ember)" : risk === "low" ? "var(--pulse)" : "var(--mist)",
    fontSize: 9,
    whiteSpace: "nowrap",
  }) as React.CSSProperties,
};
