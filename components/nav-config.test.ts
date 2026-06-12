import { describe, expect, it } from "vitest";
import { NAV_GROUPS, flattenNav, fuzzyScore, hrefFor, matchesNavItem } from "@/components/nav-config";

describe("NAV_GROUPS", () => {
  it("groups the app navigation into five operator sections", () => {
    expect(NAV_GROUPS.map((group) => group.id)).toEqual(["operate", "build", "knowledge", "govern", "setup"]);
    expect(NAV_GROUPS.flatMap((group) => group.items).map((item) => item.label)).toEqual([
      "console",
      "command",
      "goals",
      "queue",
      "missions",
      "cycles",
      "workbench",
      "mcp",
      "artifacts",
      "reports",
      "memory",
      "wiki",
      "vault graph",
      "autoresearch",
      "approvals",
      "budgets",
      "audit",
      "integrations",
      "agents",
      "agent plug",
      "settings",
    ]);
    expect(NAV_GROUPS.flatMap((group) => group.items).map((item) => item.slug)).not.toContain("app-solo");
  });

  it("keeps approvals badge metadata on the govern group", () => {
    const govern = NAV_GROUPS.find((group) => group.id === "govern");

    expect(govern?.items.find((item) => item.slug === "approvals")).toMatchObject({
      label: "approvals",
      approvalsBadge: true,
    });
  });
});

describe("navigation helpers", () => {
  it("builds console and subpage hrefs for a company", () => {
    expect(hrefFor("co_123", "")).toBe("/companies/co_123");
    expect(hrefFor("co_123", "queue")).toBe("/companies/co_123/queue");
  });

  it("flattens grouped nav with href and group labels", () => {
    expect(flattenNav("co_123").find((item) => item.slug === "workbench")).toMatchObject({
      label: "workbench",
      groupId: "build",
      groupLabel: "build",
      href: "/companies/co_123/workbench",
    });
  });

  it("supports substring and subsequence fuzzy matching", () => {
    expect(fuzzyScore("work", "workbench")).toBeGreaterThan(fuzzyScore("wb", "workbench"));
    expect(fuzzyScore("wb", "workbench")).toBeGreaterThan(0);
    expect(fuzzyScore("zz", "workbench")).toBe(-1);
  });

  it("matches item labels and keywords for the command palette", () => {
    const command = flattenNav("co_123").find((item) => item.slug === "command");

    expect(command).toBeDefined();
    expect(matchesNavItem("ceo", command!)).toBeGreaterThan(0);
  });
});
