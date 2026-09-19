/**
 * B2 — the nine seats are different CAPABILITIES, not different prompts.
 *
 * The app's manifests stay the single source of truth: `SLOT_ENVIRONMENTS` (`agent-catalog.ts`)
 * names each seat's capabilities, gates and per-run cap in integer cents, and `SEAT_MANIFESTS`
 * (`seat-manifest.ts`) names its model tier. This module is the mapping from those capability
 * strings onto Trent's own toolsets, plus the list of capabilities the CLI cannot execute at all.
 */
import { describe, expect, it } from "vitest";
import { SLOT_ENVIRONMENTS } from "@/lib/agent-catalog";
import { SEAT_MANIFESTS } from "@/lib/seat-manifest";
import type { AgentRole } from "@/lib/types";

import {
  CAPABILITY_TOOLSETS,
  SEAT_CAPABILITIES,
  SHARED_SEAT_TOOLSETS,
  seatCapability,
  seatToolsets,
} from "./seat-capabilities.js";

const ROLES = Object.keys(SLOT_ENVIRONMENTS) as AgentRole[];

describe("seat capabilities are read from the app manifests", () => {
  it("covers every seat the app defines, and nothing else", () => {
    expect(Object.keys(SEAT_CAPABILITIES).sort()).toEqual([...ROLES].sort());
    expect(ROLES.length).toBe(9);
  });

  it("the finance seat cannot call terminal and the engineer can", () => {
    expect(seatCapability("engineer").toolsets).toContain("terminal");
    expect(seatCapability("finance").toolsets).not.toContain("terminal");
    // Stricter than the floor, not looser: finance is DENIED the toolset, it is not merely unbuilt.
    expect(seatCapability("finance").denied).toContain("terminal");
    expect(seatCapability("engineer").denied).not.toContain("terminal");
  });

  it("a seat's toolsets are exactly its mapped capabilities plus the shared wrapper toolsets", () => {
    for (const role of ROLES) {
      const seat = seatCapability(role);
      const mapped = new Set(
        SLOT_ENVIRONMENTS[role].tools
          .map((capability) => CAPABILITY_TOOLSETS[capability])
          .filter((toolset): toolset is NonNullable<typeof toolset> => toolset !== undefined),
      );
      for (const toolset of SHARED_SEAT_TOOLSETS) mapped.add(toolset);
      expect([...seat.toolsets].sort(), role).toEqual([...mapped].sort());
    }
  });

  it("every capability the CLI cannot execute is recorded as unavailable with a reason, never advertised", () => {
    for (const role of ROLES) {
      const seat = seatCapability(role);
      const unmapped = SLOT_ENVIRONMENTS[role].tools.filter((capability) => CAPABILITY_TOOLSETS[capability] === undefined);
      expect(seat.unavailable.map((entry) => entry.capability).sort(), role).toEqual([...unmapped].sort());
      for (const entry of seat.unavailable) expect(entry.reason.length).toBeGreaterThan(0);
    }
    // The two the brief names by hand.
    expect(seatCapability("sales").unavailable.map((entry) => entry.capability)).toEqual(expect.arrayContaining(["crm:read", "Email"]));
  });

  it("carries the manifest budget in integer cents and the manifest model tier", () => {
    for (const role of ROLES) {
      const seat = seatCapability(role);
      expect(seat.budgetCents, role).toBe(SLOT_ENVIRONMENTS[role].budgetCentsPerRun);
      expect(Number.isInteger(seat.budgetCents), role).toBe(true);
      expect(seat.modelTier, role).toBe(SEAT_MANIFESTS[role].modelTier);
    }
    // The seats really do differ, so an enforced cap and a mapped tier are not decoration.
    expect(seatCapability("engineer").budgetCents).not.toBe(seatCapability("escalation").budgetCents);
    expect(seatCapability("engineer").modelTier).not.toBe(seatCapability("ceo").modelTier);
  });

  it("every seat carries the id of its eval suite, which is the seat id (goldens-only path)", () => {
    for (const role of ROLES) {
      expect(seatCapability(role).evalSuiteId, role).toBe(role);
    }
  });

  it("the seat's approval gates are the manifest's, on top of the absolute floors", () => {
    for (const role of ROLES) {
      expect([...seatCapability(role).approvalGates].sort(), role).toEqual([...SLOT_ENVIRONMENTS[role].approvalRequiredFor].sort());
    }
  });

  it("seatToolsets intersects the seat's capabilities with what this install actually enabled", () => {
    expect(seatToolsets("engineer", ["file_ops", "terminal", "web"])).toEqual(["file_ops", "terminal", "web"]);
    expect(seatToolsets("finance", ["file_ops", "terminal", "web"])).toEqual(["web"]);
    expect(seatToolsets("engineer", [])).toEqual([]);
  });

  it("an unknown seat is refused rather than silently given everything", () => {
    expect(() => seatCapability("browser")).toThrow(/browser/);
  });
});
