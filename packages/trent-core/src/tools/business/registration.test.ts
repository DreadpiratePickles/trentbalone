/**
 * The seven registration places (design G7) for the `business` toolset, and the three build
 * rules: it needs the egress proxy (or a test transport) because every call leaves the machine;
 * a blank slate turns it off; quick setup turns it on only when `trent connect` holds at least
 * one of its providers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolsetSchema } from "../../config/sections/tools.js";
import { BLANK_SLATE_CONFIG } from "../../config/defaults.js";
import { CAPABILITY_TOOLSETS, GATED_TOOLSETS, seatCapability } from "../../fleet/seat-capabilities.js";
import { installBoundApprovals } from "../../governance/bound-approvals.js";
import { classFloorOf } from "../../governance/autonomy.js";
import { CLASS_FLOOR } from "../../governance/gate-config-schema.js";
import { isSideEffecting } from "../../governance/idempotent-dispatch.js";
import { TOOLSET_APPROVAL_GATES } from "../../orchestrator/seat-wiring.js";
import { IMPLEMENTED_TOOLSETS, TOOLSET_BY_ADAPTER, buildTrentTools } from "../index.js";
import { BUILTIN_TOOLS_BY_TOOLSET } from "../tool-names.js";
import { BUSINESS_ADAPTER_NAME, BUSINESS_TOOL_NAMES, BUSINESS_TOOL_SCHEMAS, TOOL_CLASSES, WRITE_TOOLS } from "./schemas.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-business-reg-"));
});

afterEach(() => {
  installBoundApprovals(undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the business toolset is registered in all seven places", () => {
  it("config enum, IMPLEMENTED_TOOLSETS, TOOLSET_BY_ADAPTER, tool names, seat capabilities, seat wiring, and docs/tools.md", () => {
    expect(ToolsetSchema.options).toContain("business");
    expect(IMPLEMENTED_TOOLSETS).toContain("business");
    expect(TOOLSET_BY_ADAPTER[BUSINESS_ADAPTER_NAME]).toBe("business");
    expect(BUILTIN_TOOLS_BY_TOOLSET.business).toEqual([BUSINESS_ADAPTER_NAME, ...BUSINESS_TOOL_NAMES]);
    // Gated, never shared: a seat gets it only when its manifest names Stripe or a customer channel.
    expect(GATED_TOOLSETS).toContain("business");
    expect(CAPABILITY_TOOLSETS.Stripe).toBe("business");
    expect(seatCapability("finance").toolsets).toContain("business");
    expect(seatCapability("sales").toolsets).toContain("business");
    expect(seatCapability("engineer").toolsets).not.toContain("business");
    expect(seatCapability("engineer").denied).toContain("business");
    expect(TOOLSET_APPROVAL_GATES.business).toMatch(/^business\./);
    const doc = fs.readFileSync(path.join(process.cwd(), "docs", "tools.md"), "utf8");
    expect(doc).toContain("`business`");
    for (const name of BUSINESS_TOOL_NAMES) expect(doc, name).toContain(name);
    expect(BUSINESS_TOOL_SCHEMAS.map((schema) => schema.name)).toEqual([...BUSINESS_TOOL_NAMES]);
  });

  it("the shipped classifier floors every write and none of the reads, and agrees with the declared classes", () => {
    for (const name of BUSINESS_TOOL_NAMES) {
      const floored = classFloorOf({ adapter: BUSINESS_ADAPTER_NAME, scopes: [BUSINESS_ADAPTER_NAME, ...BUSINESS_TOOL_NAMES], tool: name, args: {} }, CLASS_FLOOR);
      if (WRITE_TOOLS.has(name)) {
        expect(floored.length, name).toBeGreaterThan(0);
        for (const cls of floored) expect(TOOL_CLASSES[name], `${name} declares ${cls}`).toContain(cls);
      } else {
        expect(floored, name).toEqual([]);
      }
    }
    // The wrapper keys these by their idempotency token; the rest carry provider-side idempotency (docs/business.md).
    for (const name of ["stripe_invoice_create", "stripe_invoice_send", "stripe_payment_link_create", "square_booking_create", "square_booking_cancel", "square_invoice_create", "square_invoice_send", "sms_send"]) {
      expect(isSideEffecting(BUSINESS_ADAPTER_NAME, name), name).toBe(true);
    }
  });

  it("is off in a blank slate", () => {
    expect(BLANK_SLATE_CONFIG.toolsets).not.toContain("business");
    expect(BLANK_SLATE_CONFIG.disabled_toolsets).toContain("business");
  });

  it("every write tool requires approval and previews; every read tool does neither", () => {
    const profileDir = path.join(root, "profile");
    fs.mkdirSync(profileDir, { recursive: true });
    const built = buildTrentTools(
      { toolsets: ["business"], disabled_toolsets: [], autonomy: "never" },
      { workspace: root, profileDir, backend: "local", home: root, business: { fetchImpl: globalThis.fetch, endpoints: {}, tokens: async () => { throw new Error("unused"); } } },
    );
    const adapter = built.adapters.find((candidate) => candidate.name === BUSINESS_ADAPTER_NAME)!;
    expect(adapter.spendsMoneyOnExecute).toBe(true);
    for (const name of BUSINESS_TOOL_NAMES) {
      const write = WRITE_TOOLS.has(name);
      expect(adapter.requiresApproval(`${name} {}`), name).toBe(write);
    }
  });

  it("is skipped with a reason when the egress proxy is not running and no test transport is given", () => {
    const profileDir = path.join(root, "profile");
    fs.mkdirSync(profileDir, { recursive: true });
    const built = buildTrentTools({ toolsets: ["business"], disabled_toolsets: [] }, { workspace: root, profileDir, backend: "local", home: root });
    expect(built.adapters.map((adapter) => adapter.name)).not.toContain(BUSINESS_ADAPTER_NAME);
    expect(built.skipped).toEqual([{ toolset: "business", reason: expect.stringMatching(/egress proxy/) }]);
  });
});
