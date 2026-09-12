import { describe, expect, it } from "vitest";
import {
  approvalPoliciesToLegacyAutoTools,
  classifyMcpToolPolicyClasses,
  defaultMcpApprovalPolicyForTool,
  mcpToolRiskLabel,
  mcpApprovalPolicyAllowsExecution,
  mcpApprovalPolicyRequiresApproval,
  normalizeMcpApprovalPolicies,
} from "@/lib/mcp-policy";

describe("MCP approval policies", () => {
  it("upgrades legacy reversible tool names into read-only auto policies", () => {
    const policies = normalizeMcpApprovalPolicies({
      legacyReversibleTools: ["stripe_search"],
      discoveredTools: [
        { name: "stripe_search", description: "Search Stripe", annotations: { readOnlyHint: true } },
        { name: "stripe_refund", description: "Refund a payment", annotations: { destructiveHint: true } },
        { name: "notion_update_page", description: "Update a page" },
      ],
    });

    expect(policies).toEqual({
      stripe_search: "read_only_auto",
      stripe_refund: "always_approve",
      notion_update_page: "approve_once",
    });
  });

  it("normalizes invalid policy objects back to safe per-tool defaults", () => {
    const policies = normalizeMcpApprovalPolicies({
      rawPolicies: {
        docs_search: "read_only_auto",
        sentry_delete_issue: "bogus",
        notion_update_page: "disabled",
        unknown_tool: "always_approve",
      },
      discoveredTools: [
        { name: "docs_search", description: "Search docs", annotations: { readOnlyHint: true } },
        { name: "sentry_delete_issue", description: "Delete an issue", annotations: { destructiveHint: true } },
        { name: "notion_update_page", description: "Update a Notion page" },
      ],
    });

    expect(policies).toEqual({
      docs_search: "read_only_auto",
      sentry_delete_issue: "always_approve",
      notion_update_page: "disabled",
    });
  });

  it("makes read-only tools auto, destructive tools always approve, and other tools approve once", () => {
    expect(defaultMcpApprovalPolicyForTool({ name: "search", description: "", annotations: { readOnlyHint: true } }))
      .toBe("read_only_auto");
    expect(defaultMcpApprovalPolicyForTool({ name: "refund", description: "", annotations: { destructiveHint: true } }))
      .toBe("always_approve");
    expect(defaultMcpApprovalPolicyForTool({ name: "create_page", description: "" })).toBe("approve_once");
  });

  it("separates approval requirement from disabled execution", () => {
    expect(mcpApprovalPolicyRequiresApproval("read_only_auto")).toBe(false);
    expect(mcpApprovalPolicyRequiresApproval("approve_once")).toBe(true);
    expect(mcpApprovalPolicyRequiresApproval("always_approve")).toBe(true);
    expect(mcpApprovalPolicyAllowsExecution("disabled")).toBe(false);
    expect(approvalPoliciesToLegacyAutoTools({ search: "read_only_auto", refund: "always_approve" })).toEqual(["search"]);
  });

  it("classifies MCP policy classes separately from approval policy", () => {
    const refund = classifyMcpToolPolicyClasses({
      name: "stripe_refund_payment",
      description: "Create a customer-facing refund for a payment",
    });
    expect(refund).toEqual(expect.arrayContaining(["write", "customer_facing", "money_moving", "destructive"]));
    expect(mcpToolRiskLabel(refund)).toBe("critical");

    const docs = classifyMcpToolPolicyClasses({
      name: "docs_search",
      description: "Search documentation",
      annotations: { readOnlyHint: true },
    });
    expect(docs).toEqual(["read_only"]);
    expect(mcpToolRiskLabel(docs)).toBe("low");
  });
});
