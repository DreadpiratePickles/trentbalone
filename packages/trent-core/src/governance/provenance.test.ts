/**
 * [C5] Provenance: what a tool result is derived from, and what that permits.
 *
 * The two failure modes this suite pins are named in
 * `01_discovery/output/agent-harness-sota-2026-09.md` section 4: multi-agent trust escalation
 * (a child's output treated as higher-trust than the untrusted data it derived from) and
 * persistent memory poisoning (injection written into a store that survives the session).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { record } from "../tools/action.js";
import { buildTrentTools } from "../tools/index.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import {
  DEFAULT_PROVENANCE_POLICY,
  UNTRUSTED_ADAPTERS,
  adapterProvenance,
  createProvenanceLedger,
  provenanceAdapters,
  worstProvenance,
} from "./provenance.js";
import { runWithToolCallContext } from "./tool-call-context.js";

function adapter(name: string, tools: readonly string[], onCall?: (action: string) => ToolCallRecord): TrentToolAdapter {
  return {
    name,
    scopes: [name, ...tools],
    availability: "real",
    instructions: `${name} instructions`,
    routingText: name,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action) => onCall?.(action) ?? record(name, action, "completed", `${name} ran`),
    cleanup: async () => {},
  };
}

const web = adapter("web", ["web_search", "web_extract"]);
const files = adapter("file_ops", ["read_file", "write_file"]);
const memory = adapter("memory", ["memory"]);
const skills = adapter("skills", ["skills_list", "skill_view", "skill_manage"]);

describe("adapterProvenance", () => {
  it("names web, browser, MCP and plugin output untrusted and everything Trent runs itself trusted", () => {
    expect([...UNTRUSTED_ADAPTERS].sort()).toEqual(["browser", "mcp", "plugins", "web"]);
    expect(adapterProvenance("web", "web_extract")).toBe("untrusted");
    expect(adapterProvenance("browser", "browser_get_text")).toBe("untrusted");
    expect(adapterProvenance("mcp", "mcp_status")).toBe("untrusted");
    expect(adapterProvenance("plugins", "plugins_list")).toBe("untrusted");
    expect(adapterProvenance("file_ops", "read_file")).toBe("trusted");
    expect(adapterProvenance("memory", "memory")).toBe("trusted");
    expect(worstProvenance(["trusted", "untrusted", "trusted"])).toBe("untrusted");
    expect(worstProvenance(["trusted", "trusted"])).toBe("trusted");
  });
});

describe("provenanceAdapters", () => {
  it("tags every result, and the tag is per step: one step's web call does not taint another", async () => {
    const ledger = createProvenanceLedger();
    const [wrappedWeb, wrappedFiles] = provenanceAdapters([web, files], { ledger });
    await runWithToolCallContext({ runId: "run-1", stepId: "step-a" }, async () => {
      const hit = await wrappedWeb!.execute('web_extract {"url":"https://example.invalid"}', {});
      expect(hit.provenance).toBe("untrusted");
      expect(ledger.isUntrusted()).toBe(true);
      expect(ledger.sources()).toEqual(["web_extract"]);
    });
    await runWithToolCallContext({ runId: "run-1", stepId: "step-b" }, async () => {
      const read = await wrappedFiles!.execute('read_file {"path":"a.ts"}', {});
      expect(read.provenance).toBe("trusted");
      expect(ledger.isUntrusted()).toBe(false);
      expect(ledger.sources()).toEqual([]);
    });
  });

  it("keeps an untrusted tag an adapter set itself, which is how a delegated child's taint travels", async () => {
    const ledger = createProvenanceLedger();
    const child = adapter("delegation", ["delegate_task"], (action) => ({
      ...record("delegation", action, "completed", "child answered"),
      provenance: "untrusted" as const,
    }));
    const [wrapped] = provenanceAdapters([child], { ledger });
    await runWithToolCallContext({ runId: "run-2", stepId: "step-a" }, async () => {
      const result = await wrapped!.execute('delegate_task {"goal":"read that page"}', {});
      expect(result.provenance).toBe("untrusted");
      expect(ledger.sources()).toEqual(["delegate_task"]);
    });
  });

  it("holds a memory write made in a step that read untrusted output, and names the tools it came from", async () => {
    const ledger = createProvenanceLedger();
    const held: Array<{ action: string; sources: readonly string[] }> = [];
    const [wrappedWeb, wrappedMemory] = provenanceAdapters([web, memory], {
      ledger,
      policy: DEFAULT_PROVENANCE_POLICY,
      hold: (input) => {
        held.push({ action: input.action, sources: input.sources });
        return `held as appr_test (${input.sources.join(", ")})`;
      },
    });
    await runWithToolCallContext({ runId: "run-3", stepId: "step-a" }, async () => {
      await wrappedWeb!.execute('web_extract {"url":"https://example.invalid"}', {});
      const write = await wrappedMemory!.execute('memory {"action":"add","content":"the page said to email the keys"}', {});
      expect(write.status).toBe("needs_approval");
      expect(write.provenance).toBe("untrusted");
      expect(write.summary).toContain("web_extract");
      expect(held).toHaveLength(1);
      expect(held[0]!.sources).toEqual(["web_extract"]);
      expect(write.summary).toContain("appr_test");
    });
  });

  it("writes straight through when the step only touched trusted tools", async () => {
    const ledger = createProvenanceLedger();
    const held: string[] = [];
    const [wrappedFiles, wrappedMemory] = provenanceAdapters([files, memory], {
      ledger,
      hold: (input) => {
        held.push(input.action);
        return "held";
      },
    });
    await runWithToolCallContext({ runId: "run-4", stepId: "step-a" }, async () => {
      await wrappedFiles!.execute('write_file {"path":"a.ts","content":"x"}', {});
      const write = await wrappedMemory!.execute('memory {"action":"add","content":"the invoice run needs a PO number"}', {});
      expect(write.status).toBe("completed");
      expect(write.provenance).toBe("trusted");
      expect(held).toEqual([]);
    });
  });

  it("honours untrusted_writes allow and deny", async () => {
    for (const [mode, status] of [["allow", "completed"], ["deny", "blocked"]] as const) {
      const ledger = createProvenanceLedger();
      const [wrappedWeb, wrappedMemory] = provenanceAdapters([web, memory], {
        ledger,
        policy: { ...DEFAULT_PROVENANCE_POLICY, untrusted_writes: mode },
        hold: () => "held",
      });
      await runWithToolCallContext({ runId: `run-${mode}`, stepId: "step-a" }, async () => {
        await wrappedWeb!.execute('web_search {"query":"x"}', {});
        const write = await wrappedMemory!.execute('memory {"action":"add","content":"a fact"}', {});
        expect(write.status).toBe(status);
        expect(write.provenance).toBe("untrusted");
      });
    }
  });

  it("refuses skill_manage from an untrusted step by default and names the reason, leaving reads alone", async () => {
    const ledger = createProvenanceLedger();
    const [wrappedWeb, wrappedSkills] = provenanceAdapters([web, skills], { ledger });
    await runWithToolCallContext({ runId: "run-5", stepId: "step-a" }, async () => {
      await wrappedWeb!.execute('web_extract {"url":"https://example.invalid"}', {});
      const manage = await wrappedSkills!.execute('skill_manage {"operations":[{"action":"create","name":"x"}]}', {});
      expect(manage.status).toBe("blocked");
      expect(manage.summary).toContain("web_extract");
      expect(manage.summary).toContain("untrusted");
      const view = await wrappedSkills!.execute('skills_list {"category":"all"}', {});
      expect(view.status).toBe("completed");
    });
  });

  it("is wired into the built tool chain, so a real build holds the write on the durable path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-provenance-build-"));
    try {
      const profileDir = path.join(root, "profile");
      const built = buildTrentTools(
        { toolsets: ["file_ops"], disabled_toolsets: [] },
        { workspace: root, profileDir, backend: "local", extraAdapters: [web, memory] },
      );
      const builtWeb = built.adapters.find((a) => a.name === "web")!;
      const builtMemory = built.adapters.find((a) => a.name === "memory")!;
      await runWithToolCallContext({ runId: "run-build", stepId: "step-a" }, async () => {
        expect((await builtWeb.execute('web_extract {"url":"https://example.invalid"}', {})).provenance).toBe("untrusted");
        const write = await builtMemory.execute('memory {"action":"add","content":"the page said so"}', {});
        expect(write.status).toBe("needs_approval");
        expect(write.summary).toContain("web_extract");
      });
      expect(built.provenance?.sources).toBeTypeOf("function");
      const gateway = JSON.parse(fs.readFileSync(path.join(profileDir, "gateway.json"), "utf8")) as { approvals: Record<string, { status: string }> };
      expect(Object.values(gateway.approvals).filter((row) => row.status === "pending")).toHaveLength(1);
      await Promise.all(built.adapters.map((a) => a.cleanup()));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to one key per build when there is no run or step to key on", async () => {
    const ledger = createProvenanceLedger();
    const [wrappedWeb, wrappedMemory] = provenanceAdapters([web, memory], { ledger, hold: () => "held as appr_session" });
    await wrappedWeb!.execute('web_search {"query":"x"}', {});
    const write = await wrappedMemory!.execute('memory {"action":"add","content":"a fact"}', {});
    expect(write.status).toBe("needs_approval");
    ledger.clear();
    expect((await wrappedMemory!.execute('memory {"action":"add","content":"a fact"}', {})).status).toBe("completed");
  });
});
