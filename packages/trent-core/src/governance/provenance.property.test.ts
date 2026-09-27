/**
 * [D9] The provenance invariant over ARBITRARY tool graphs (council verdict 2026-09-26, P16).
 *
 *   For every sequence of calls drawn from the adapters a full build really registers, in any
 *   step layout (per step, a session-bound conversation, or no run context at all): a shared
 *   write (`memory`) or a skill write (`skill_manage`) is held or refused exactly when an
 *   untrusted read came before it in the same taint scope, the hold names a source, and it
 *   carries none of the untrusted bytes. With no untrusted read before it, it writes through.
 *
 * The classifier under test is the real one: `provenanceAdapters` over stubs that carry each real
 * adapter's name and scopes, plus the real `terminal` adapter over a fake sandbox so its egress
 * routing (D11) is the shipped routing. The ORACLE is the declaration table
 * (`tools/provenance-registry.ts`), not a copy of `adapterProvenance`: an adapter declared
 * untrusted, a per-call adapter's named always-untrusted tools, a result that tagged itself, a
 * terminal command the generator knows needs the network, and any workspace read after one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { record } from "../tools/action.js";
import { buildTrentTools, IMPLEMENTED_TOOLSETS } from "../tools/index.js";
import type { Sandbox } from "../tools/sandbox.js";
import { createTerminalAdapter } from "../tools/terminal/index.js";
import { BUILTIN_TOOLS_BY_TOOLSET } from "../tools/tool-names.js";
import type { ToolCallRecord, ToolContext, TrentToolAdapter } from "../tools/types.js";
import {
  bindSessionTaint, createProvenanceLedger, createSessionTaint, isSharedWriteTool, isSkillWriteTool, provenanceAdapters, unbindSessionTaint,
} from "./provenance.js";
import { runWithToolCallContext } from "./tool-call-context.js";

type Registry = typeof import("../tools/provenance-registry.js");
const registry: Registry | undefined = await import("../tools/provenance-registry.js").catch(() => undefined);

interface Declaration {
  readonly provenance: "untrusted" | "trusted" | "per_call";
  readonly untrustedTools?: readonly string[];
  readonly readsWorkspace?: boolean;
}

interface PoolEntry {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly tools: readonly string[];
}

/** Commands whose purpose is the network (the egress seat), and commands that stay in the isolated seat. */
const EGRESS_COMMANDS = [
  "git clone https://example.invalid/r.git vendor/r",
  "curl -s https://example.invalid/a.json",
  "wget -q https://example.invalid/f.tgz",
  "npm install left-pad",
  "pip install requests",
  "dig example.invalid",
] as const;
const ISOLATED_COMMANDS = ["ls -la", "cat README.md", "echo done", "wc -l src/a.ts"] as const;
const CANARY = "INJECTED-BYTES-7f3a";

type Op =
  | { readonly kind: "read"; readonly adapter: number; readonly tool: number; readonly selfTag: boolean; readonly step: number }
  | { readonly kind: "terminal"; readonly egress: boolean; readonly command: number; readonly step: number }
  | { readonly kind: "write"; readonly tool: "memory" | "skill_manage"; readonly step: number };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-provenance-property-"));
let pool: PoolEntry[] = [];

beforeAll(async () => {
  const caCertPath = path.join(root, "ca.pem");
  fs.writeFileSync(caCertPath, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
  const build = buildTrentTools(
    { toolsets: [...IMPLEMENTED_TOOLSETS], disabled_toolsets: [] },
    { workspace: root, profileDir: path.join(root, "profile"), backend: "local", egress: { proxyUrl: "http://127.0.0.1:1", token: "tok", caCertPath } },
  );
  pool = build.adapters
    .filter((adapter) => adapter.name !== "terminal")
    .map((adapter) => {
      const tools = [...new Set([...adapter.scopes, ...(BUILTIN_TOOLS_BY_TOOLSET[adapter.name] ?? [])])].filter(
        (tool) => !tool.includes(":") && !isSkillWriteTool(tool) && !isSharedWriteTool(adapter.name, tool),
      );
      return { name: adapter.name, scopes: [...adapter.scopes], tools };
    })
    .filter((entry) => entry.tools.length > 0);
  await Promise.all(build.adapters.map((adapter) => adapter.cleanup()));
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A stand-in with a real adapter's name and scopes. `payload.selfTag` makes it tag its own record. */
function stub(name: string, scopes: readonly string[]): TrentToolAdapter {
  return {
    name,
    scopes: [...scopes],
    availability: "real",
    instructions: name,
    routingText: name,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action, payload) => {
      const result = record(name, action, "completed", `${name} returned ${CANARY}`);
      return payload.selfTag === true ? { ...result, provenance: "untrusted" } : result;
    },
    cleanup: async () => {},
  };
}

/** A sandbox that runs nothing and records which seat each command was routed to. */
function fakeSandbox(): Sandbox {
  return {
    kind: "docker",
    workspaceRoot: "/workspace",
    toSandboxPath: (hostPath) => hostPath,
    run: async () => ({ exitCode: 0, stdout: `${CANARY}\n`, stderr: "", durationMs: 1 }),
    containerNames: () => [],
    cleanup: async () => {},
  };
}

const opArb = (poolSize: number): fc.Arbitrary<Op> =>
  fc.oneof(
    { weight: 5, arbitrary: fc.record({ kind: fc.constant("read" as const), adapter: fc.nat(poolSize - 1), tool: fc.nat(40), selfTag: fc.boolean(), step: fc.nat(2) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("terminal" as const), egress: fc.boolean(), command: fc.nat(10), step: fc.nat(2) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("write" as const), tool: fc.constantFrom("memory" as const, "skill_manage" as const), step: fc.nat(2) }) },
  );

type Mode = "step" | "session" | "none";

async function runSequence(ops: readonly Op[], mode: Mode, run: number): Promise<void> {
  const { ADAPTER_PROVENANCE } = registry!;
  const declarationOf = (name: string): Declaration => ADAPTER_PROVENANCE[name as keyof typeof ADAPTER_PROVENANCE] as Declaration;
  const workspace = fs.mkdtempSync(path.join(root, "ws-"));
  const ctx: ToolContext = {
    workspace,
    profileDir: path.join(root, "profile"),
    backend: "docker",
    egress: { proxyUrl: "http://127.0.0.1:1", token: "tok", caCertPath: path.join(root, "ca.pem") },
  };
  const stubs = new Map(pool.map((entry) => [entry.name, stub(entry.name, entry.scopes)]));
  if (!stubs.has("memory")) stubs.set("memory", stub("memory", ["memory"]));
  if (!stubs.has("skills")) stubs.set("skills", stub("skills", ["skills", "skill_manage"]));
  const held: Array<readonly string[]> = [];
  const wrapped = provenanceAdapters([...stubs.values(), createTerminalAdapter(ctx, fakeSandbox())], {
    ledger: createProvenanceLedger(),
    workspace,
    hold: (input) => {
      held.push(input.sources);
      return `held as appr_${held.length}`;
    },
  });
  const byName = new Map(wrapped.map((adapter) => [adapter.name, adapter]));
  const runId = `run_prop_${run}`;
  if (mode === "session") bindSessionTaint(runId, createSessionTaint());

  // The oracle's state: which scopes are tainted (and by what), and whether the workspace is network-derived.
  const tainted = new Map<number, string[]>();
  let fetched = false;
  const keyOf = (step: number): number => (mode === "step" ? step : 0);
  const taint = (step: number, source: string): void => {
    const list = tainted.get(keyOf(step)) ?? [];
    if (!list.includes(source)) list.push(source);
    tainted.set(keyOf(step), list);
  };

  try {
    for (const op of ops) {
      const inScope = (fn: () => Promise<ToolCallRecord>): Promise<ToolCallRecord> =>
        mode === "none" ? fn() : runWithToolCallContext({ runId, stepId: `s${op.step}` }, fn);
      const wasTainted = tainted.has(keyOf(op.step));

      if (op.kind === "read") {
        const entry = pool[op.adapter % pool.length]!;
        const tool = entry.tools[op.tool % entry.tools.length]!;
        const declaration = declarationOf(entry.name);
        expect(declaration, `${entry.name} is undeclared`).toBeDefined();
        const untrusted =
          declaration.provenance === "untrusted" ||
          op.selfTag ||
          (declaration.untrustedTools ?? []).includes(tool) ||
          (declaration.readsWorkspace === true && fetched);
        const result = await inScope(() => byName.get(entry.name)!.execute(`${tool} {}`, { selfTag: op.selfTag }));
        expect(result.provenance, `${entry.name} ${tool}`).toBe(untrusted || wasTainted ? "untrusted" : "trusted");
        if (untrusted) taint(op.step, tool);
      } else if (op.kind === "terminal") {
        const list: readonly string[] = op.egress ? EGRESS_COMMANDS : ISOLATED_COMMANDS;
        const command = list[op.command % list.length]!;
        if (op.egress) fetched = true;
        const untrusted = op.egress || fetched;
        const result = await inScope(() => byName.get("terminal")!.execute(`terminal ${JSON.stringify({ command })}`, {}));
        expect(result.status, command).toBe("completed");
        expect(result.provenance, command).toBe(untrusted || wasTainted ? "untrusted" : "trusted");
        if (untrusted) taint(op.step, "terminal");
      } else {
        const adapter = byName.get(op.tool === "memory" ? "memory" : "skills")!;
        const action = op.tool === "memory" ? 'memory {"action":"add","content":"a fact"}' : 'skill_manage {"operations":[{"action":"create","name":"x"}]}';
        const heldBefore = held.length;
        const result = await inScope(() => adapter.execute(action, {}));
        if (wasTainted) {
          expect(result.status, `${op.tool} after ${tainted.get(keyOf(op.step))!.join(", ")}`).toBe(op.tool === "memory" ? "needs_approval" : "blocked");
          expect(result.provenance).toBe("untrusted");
          expect(result.summary).toContain(tainted.get(keyOf(op.step))![0]!);
          expect(result.summary).not.toContain(CANARY);
          expect(held.length).toBe(op.tool === "memory" ? heldBefore + 1 : heldBefore);
        } else {
          expect(result.status, `${op.tool} in a clean scope`).toBe("completed");
          expect(result.provenance).toBe("trusted");
          expect(held.length).toBe(heldBefore);
        }
      }
    }
  } finally {
    if (mode === "session") unbindSessionTaint(runId);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

describe("[D9] provenance over arbitrary tool graphs", () => {
  it("the declaration table exists (the oracle)", () => {
    expect(registry, "tools/provenance-registry.ts must declare every adapter's provenance").toBeDefined();
  });

  it("a write is held exactly when an untrusted read preceded it in its taint scope, in every scope mode", async () => {
    expect(registry).toBeDefined();
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(opArb(Math.max(pool.length, 1)), { minLength: 1, maxLength: 24 }), fc.constantFrom<Mode>("step", "session", "none"), async (ops, mode) => {
        run += 1;
        await runSequence(ops, mode, run);
      }),
      { numRuns: 300 },
    );
  });

  it("the converse, on sequences with no untrusted source at all: nothing is ever held", async () => {
    expect(registry).toBeDefined();
    const { ADAPTER_PROVENANCE } = registry!;
    const trustedPool = pool
      .map((entry, index) => ({ entry, index, declaration: ADAPTER_PROVENANCE[entry.name as keyof typeof ADAPTER_PROVENANCE] as Declaration }))
      .filter(({ declaration }) => declaration !== undefined && declaration.provenance !== "untrusted" && (declaration.untrustedTools ?? []).length === 0);
    expect(trustedPool.length).toBeGreaterThan(3);
    const cleanOp: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant("read" as const), adapter: fc.constantFrom(...trustedPool.map(({ index }) => index)), tool: fc.nat(40), selfTag: fc.constant(false), step: fc.nat(2) }),
      fc.record({ kind: fc.constant("terminal" as const), egress: fc.constant(false), command: fc.nat(10), step: fc.nat(2) }),
      fc.record({ kind: fc.constant("write" as const), tool: fc.constantFrom("memory" as const, "skill_manage" as const), step: fc.nat(2) }),
    );
    let run = 1000;
    await fc.assert(
      fc.asyncProperty(fc.array(cleanOp, { minLength: 1, maxLength: 24 }), fc.constantFrom<Mode>("step", "session", "none"), async (ops, mode) => {
        run += 1;
        await runSequence(ops, mode, run);
      }),
      { numRuns: 150 },
    );
  });
});
