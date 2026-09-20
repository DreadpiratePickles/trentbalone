/**
 * [U1] The gate at the seam. `buildTrentTools` is the one place every adapter is wrapped, so the
 * five mechanisms are proved THROUGH it, on fake executors registered as `extraAdapters` the way
 * a market toolset will be, with `autonomy: never` — the level that used to lift adapter approval.
 * Nothing here calls a model, a provider or the network: each fake records what reached it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTrentTools } from "../tools/index.js";
import { record } from "../tools/action.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { IdempotencyManager } from "./IdempotencyManager.js";
import { createBoundApprovalStore, installBoundApprovals, type BoundApprovalStore } from "./bound-approvals.js";
import { MemoryGatewayStore } from "../gateway/store/GatewayStore.js";
import { runWithToolCallContext } from "./tool-call-context.js";

let home: string;
let profileDir: string;
let workspace: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-gate-home-"));
  profileDir = path.join(home, ".trent", "default");
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-gate-work-"));
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(() => {
  installBoundApprovals(undefined);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function fake(name: string, scopes: string[], executed: string[], preview?: (action: string) => string): TrentToolAdapter {
  return {
    name,
    scopes,
    availability: "real",
    instructions: "",
    routingText: "",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    ...(preview === undefined ? {} : { preview }),
    async execute(action: string): Promise<ToolCallRecord> {
      executed.push(`${name} ${action}`);
      return record(name, action, "completed", `${name} did it: ${action}`);
    },
    async cleanup() {},
  };
}

interface Built {
  readonly byName: (name: string) => TrentToolAdapter;
  readonly executed: string[];
  readonly bindings: BoundApprovalStore;
}

function build(config: Record<string, unknown> = {}): Built {
  const executed: string[] = [];
  const bindings = createBoundApprovalStore({ store: new MemoryGatewayStore() });
  const social = fake("social", ["social", "inbox_list", "post_update", "inbound"], executed, (action) => `Instagram post: ${JSON.parse(action.slice(action.indexOf("{"))).text}`);
  const twilio = fake("twilio", ["twilio", "sms"], executed);
  const payments = fake("payments", ["payments", "charge_card"], executed);
  const built = buildTrentTools(
    { toolsets: ["file_ops"], disabled_toolsets: [], autonomy: "never", ...config },
    { workspace, profileDir, backend: "local", home, idempotency: new IdempotencyManager(), extraAdapters: [social, twilio, payments], bindings, autoApproveWrites: true },
  );
  return {
    executed,
    bindings,
    byName: (name) => {
      const found = built.adapters.find((adapter) => adapter.name === name);
      if (!found) throw new Error(`the ${name} adapter was not built`);
      return found;
    },
  };
}

const POST = 'post_update {"text":"we are open until 9pm tonight"}';
const POST_2 = 'post_update {"text":"half price cocktails until close"}';
const SMS = 'sms {"to":"+15550100","body":"your table is booked"}';
const CHARGE = 'charge_card {"customer":"cus_1","amount_cents":1250}';
const in1 = <T>(fn: () => Promise<T>): Promise<T> => runWithToolCallContext({ runId: "run_1", stepId: "step_1" }, fn);
const in2 = <T>(fn: () => Promise<T>): Promise<T> => runWithToolCallContext({ runId: "run_2", stepId: "step_1" }, fn);

describe("G1 through the builder: autonomy never cannot lift the class floor", () => {
  it("asks for a post, an SMS and a charge, executes none of them unapproved, and still runs a read", async () => {
    const { byName, executed } = build();
    for (const [name, action] of [["social", POST], ["twilio", SMS], ["payments", CHARGE]] as const) {
      const adapter = byName(name);
      expect(adapter.requiresApproval(action), name).toBe(true);
      expect((await in1(() => adapter.execute(action, {}))).status, name).toBe("needs_approval");
    }
    expect(executed).toEqual([]);
    expect((await in1(() => byName("social").execute('inbox_list {"limit":3}', {}))).status).toBe("completed");
    fs.writeFileSync(path.join(workspace, "README.md"), "hello\n");
    expect((await in1(() => byName("file_ops").execute('read_file {"path":"README.md"}', {}))).status).toBe("completed");
  });

  it("gate.ask_classes can add a class to the floor and cannot remove one", async () => {
    const { byName } = build({ gate: { ask_classes: ["write"] } });
    fs.writeFileSync(path.join(workspace, "a.txt"), "x\n");
    expect(byName("file_ops").requiresApproval('write_file {"path":"a.txt","content":"y"}')).toBe(true);
    expect(byName("twilio").requiresApproval(SMS)).toBe(true);
  });
});

describe("G2 through the builder: the approval is bound to the previewed call", () => {
  it("previews at the pause, runs the replay, parks the next post of the same step, and stores the preview", async () => {
    const { byName, executed, bindings } = build();
    const social = byName("social");
    const pause = await in1(() => social.dryRun!(POST, {}));
    expect(pause.status).toBe("needs_approval");
    expect(pause.summary).toContain("Instagram post: we are open until 9pm tonight");
    expect((await in1(() => social.execute(POST, {}))).status).toBe("completed");
    expect((await in1(() => social.execute(POST_2, {}))).status).toBe("needs_approval");
    expect((await in1(() => byName("twilio").execute(SMS, {}))).status).toBe("needs_approval");
    expect(executed).toEqual([`social ${POST}`]);
    expect(bindings.list().map((row) => row.details.preview)).toEqual(["Instagram post: half price cocktails until close", '{"to":"+15550100","body":"your table is booked"}']);
  });

  it("a second identical post in the step returns the first result and does not post twice (G3)", async () => {
    const { byName, executed } = build();
    const social = byName("social");
    await in1(() => social.dryRun!(POST, {}));
    const first = await in1(() => social.execute(POST, {}));
    const again = await in1(() => social.execute(POST, {}));
    expect(again.status).toBe("completed");
    expect(again.summary).toBe(first.summary);
    expect(executed).toEqual([`social ${POST}`]);
  });
});

describe("G4 through the builder: a send after an inbound read asks because of the read", () => {
  it("a fake inbox read followed by a fake post names send-after-untrusted; a post with no untrusted read is G1 alone", async () => {
    const { byName } = build();
    const social = byName("social");
    const read = await in1(() => social.execute('inbox_list {"limit":3}', {}));
    expect(read.provenance).toBe("untrusted");
    const tainted = await in1(() => social.dryRun!(POST, {}));
    expect(tainted.status).toBe("needs_approval");
    expect(tainted.summary).toContain("send-after-untrusted");
    expect(tainted.summary).toContain("Class floor");

    const clean = await in2(() => social.dryRun!(POST, {}));
    expect(clean.status).toBe("needs_approval");
    expect(clean.summary).toContain("Class floor");
    expect(clean.summary).not.toContain("send-after-untrusted");
  });
});
