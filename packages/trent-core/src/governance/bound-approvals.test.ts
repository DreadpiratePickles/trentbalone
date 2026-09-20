/**
 * [U1] G2 — an approval is bound to ONE call. The seat loop grants approval for the rest of a
 * step once a human says yes (`apps/web/lib/seat-agent-loop.ts:209`, `orchestrator-run-phases.ts:253`),
 * so the binding has to be checked inside `execute`, against the idempotency key
 * `{runId, stepId, tool, args}`, and what the human was shown has to be what is stored.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalBridge } from "../gateway/ApprovalBridge.js";
import { FileGatewayStore, MemoryGatewayStore } from "../gateway/store/GatewayStore.js";
import { record } from "../tools/action.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { autonomyAdapters } from "./autonomy-dispatch.js";
import { boundCallKey, createBoundApprovalStore, installBoundApprovals, requireBoundApproval, type BoundCall } from "./bound-approvals.js";
import { toolCallKey } from "./IdempotencyManager.js";
import { runWithToolCallContext } from "./tool-call-context.js";

let home: string;
let profileDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-bound-"));
  profileDir = path.join(home, ".trent", "default");
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(() => {
  installBoundApprovals(undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

const STEP = { runId: "run_1", stepId: "step_1" };
const A = 'send_sms {"to":"+15550100","body":"your table is booked for 7pm"}';
const A_REORDERED = 'send_sms {"body":"your table is booked for 7pm","to":"+15550100"}';
const A_CHANGED = 'send_sms {"to":"+15550100","body":"your table is booked for 8pm"}';
const B = 'send_sms {"to":"+15550199","body":"your table is booked for 7pm"}';

const inStep = <T>(fn: () => Promise<T>): Promise<T> => runWithToolCallContext(STEP, fn);

function smsAdapter(executed: string[], preview?: (action: string) => string): TrentToolAdapter {
  return {
    name: "sms",
    scopes: ["sms", "send_sms"],
    availability: "real",
    instructions: "",
    routingText: "",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    ...(preview === undefined ? {} : { preview }),
    async execute(action: string): Promise<ToolCallRecord> {
      executed.push(action);
      return record("sms", action, "completed", "sent");
    },
    async cleanup() {},
  };
}

function wrap(adapter: TrentToolAdapter, over: Partial<Parameters<typeof autonomyAdapters>[1]> = {}): TrentToolAdapter {
  return autonomyAdapters([adapter], { level: "never", deny: [], hardline: { home, profileDir }, ...over })[0]!;
}

describe("the binding key", () => {
  it("is the idempotency key of {runId, stepId, tool, args}, so an argument order is not a new call", () => {
    const call: BoundCall = { adapter: "sms", action: A, tool: "send_sms", args: { to: "+15550100", body: "hi" }, ...STEP };
    expect(boundCallKey(call)).toBe(toolCallKey({ runId: "run_1", stepId: "step_1", tool: "sms:send_sms", args: { to: "+15550100", body: "hi" } }));
    expect(boundCallKey({ ...call, args: { body: "hi", to: "+15550100" } })).toBe(boundCallKey(call));
    expect(boundCallKey({ ...call, args: { to: "+15550100", body: "hi!" } })).not.toBe(boundCallKey(call));
    expect(boundCallKey({ ...call, stepId: "step_2" })).not.toBe(boundCallKey(call));
    // A bare JSON action has an empty tool head in both keys, so they still agree byte for byte.
    expect(boundCallKey({ ...call, action: '{"to":"+15550100","body":"hi"}', tool: "" })).toBe(toolCallKey({ runId: "run_1", stepId: "step_1", tool: "sms:", args: { to: "+15550100", body: "hi" } }));
  });
});

describe("yes to call A does not approve call B in the same step", () => {
  it("runs the previewed call on its replay and parks the next send of the step unapproved", async () => {
    const executed: string[] = [];
    const wrapped = wrap(smsAdapter(executed));
    // The pause: the seat loop asks, the human is shown A's preview, the step resumes with a loop-wide grant.
    const dry = await inStep(() => wrapped.dryRun!(A, {}));
    expect(dry.status).toBe("needs_approval");
    expect(dry.summary).toContain("+15550100");
    // The replay of exactly A runs.
    expect((await inStep(() => wrapped.execute(A, {}))).status).toBe("completed");
    // The next send in the same step, under the same loop-wide grant, does not.
    const second = await inStep(() => wrapped.execute(B, {}));
    expect(second.status).toBe("needs_approval");
    expect(second.summary).toContain("+15550199");
    expect(executed).toEqual([A]);
  });

  it("a changed argument invalidates the approval; a reordered one does not", async () => {
    const executed: string[] = [];
    const wrapped = wrap(smsAdapter(executed));
    await inStep(() => wrapped.dryRun!(A, {}));
    expect((await inStep(() => wrapped.execute(A_CHANGED, {}))).status).toBe("needs_approval");
    expect(executed).toEqual([]);
    expect((await inStep(() => wrapped.execute(A_REORDERED, {}))).status).toBe("completed");
    expect(executed).toEqual([A_REORDERED]);
  });

  it("outside a seat turn a previewed call is never granted by replay; only an explicit decision on the row is", async () => {
    const executed: string[] = [];
    const store = createBoundApprovalStore({ profileDir });
    const wrapped = wrap(smsAdapter(executed), { bindings: store });
    await wrapped.dryRun!(A, {});
    const parked = await wrapped.execute(A, {});
    expect(parked.status).toBe("needs_approval");
    expect(executed).toEqual([]);
    const row = store.list()[0]!;
    expect(parked.summary).toContain(row.id);
    // The founder decides the row through the same file `trent approvals approve <id>` writes.
    new ApprovalBridge({ store: new FileGatewayStore(path.join(profileDir, "gateway.json")) }).decide(row.id, "approved", "human");
    expect((await wrapped.execute(A, {})).status).toBe("completed");
    expect(executed).toEqual([A]);
  });

  it("a rejected row blocks exactly that call and nothing else", async () => {
    const executed: string[] = [];
    const store = createBoundApprovalStore({ store: new MemoryGatewayStore() });
    const wrapped = wrap(smsAdapter(executed), { bindings: store });
    const parked = await inStep(() => wrapped.execute(A, {}));
    expect(parked.status).toBe("needs_approval");
    store.decide(store.list()[0]!.id, "denied", "human");
    expect((await inStep(() => wrapped.execute(A, {}))).status).toBe("blocked");
    expect(executed).toEqual([]);
  });
});

describe("the preview is what is stored", () => {
  it("stores the adapter's own preview on the row and shows it in the summary; the arguments are the fallback", async () => {
    const store = createBoundApprovalStore({ store: new MemoryGatewayStore() });
    const wrapped = wrap(smsAdapter([], (action) => `SMS to +15550100: ${JSON.parse(action.slice(action.indexOf("{"))).body}`), { bindings: store });
    const dry = await inStep(() => wrapped.dryRun!(A, {}));
    const row = store.list()[0]!;
    expect(row.details.preview).toBe("SMS to +15550100: your table is booked for 7pm");
    expect(row.details.tool).toBe("send_sms");
    expect(row.details.key).toBe(boundCallKey({ adapter: "sms", action: A, tool: "send_sms", args: JSON.parse(A.slice(A.indexOf("{"))), ...STEP }));
    expect(row.runId).toBe("run_1");
    expect(row.stepId).toBe("step_1");
    expect(row.status).toBe("pending");
    expect(dry.summary).toContain(row.details.preview);
    expect(dry.summary).toContain(row.id);

    const plain = createBoundApprovalStore({ store: new MemoryGatewayStore() });
    await inStep(() => wrap(smsAdapter([]), { bindings: plain }).dryRun!(A, {}));
    expect(plain.list()[0]!.details.preview).toBe('{"to":"+15550100","body":"your table is booked for 7pm"}');
  });

  it("persists the row in <profile>/gateway.json, mode 0600, as a pending approval a founder can list", async () => {
    const wrapped = wrap(smsAdapter([]));
    await inStep(() => wrapped.dryRun!(A, {}));
    const file = path.join(profileDir, "gateway.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const rows = Object.values(JSON.parse(fs.readFileSync(file, "utf8")).approvals as Record<string, { status: string; details: { kind: string; preview: string } }>);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.details.kind).toBe("bound_call");
    expect(rows[0]!.details.preview).toContain("7pm");
  });
});

describe("requireBoundApproval, the helper an adapter calls inside execute", () => {
  const call = (action: string): BoundCall => ({ adapter: "sms", action, tool: "send_sms", args: JSON.parse(action.slice(action.indexOf("{"))), ...STEP });

  it("parks an unapproved call with the preview and grants it only once the row is approved", () => {
    const store = createBoundApprovalStore({ store: new MemoryGatewayStore() });
    const first = requireBoundApproval(call(A), "SMS to +15550100: 7pm", store);
    expect(first.granted).toBe(false);
    if (first.granted) throw new Error("unreachable");
    expect(first.record.status).toBe("needs_approval");
    expect(first.record.summary).toContain("SMS to +15550100: 7pm");
    expect(store.list()[0]!.details.preview).toBe("SMS to +15550100: 7pm");
    expect(first.row?.id).toBe(store.list()[0]!.id);
    store.decide(first.row!.id, "approved", "human");
    expect(requireBoundApproval(call(A), "SMS to +15550100: 7pm", store).granted).toBe(true);
    // The approval does not travel to a different argument.
    expect(requireBoundApproval(call(A_CHANGED), "SMS to +15550100: 8pm", store).granted).toBe(false);
  });

  it("does not let a later preview rewrite what the human already saw", () => {
    const store = createBoundApprovalStore({ store: new MemoryGatewayStore() });
    requireBoundApproval(call(A), "first preview", store);
    requireBoundApproval(call(A), "second preview", store);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.details.preview).toBe("first preview");
  });

  it("uses the installed store by default and refuses, naming the gap, when none is installed", () => {
    const none = requireBoundApproval(call(A), "p");
    expect(none.granted).toBe(false);
    if (none.granted) throw new Error("unreachable");
    expect(none.record.status).toBe("needs_approval");
    expect(none.record.summary).toContain("installBoundApprovals");
    const store = createBoundApprovalStore({ store: new MemoryGatewayStore() });
    installBoundApprovals(store);
    expect(requireBoundApproval(call(A), "p").granted).toBe(false);
    expect(store.list()).toHaveLength(1);
  });
});
