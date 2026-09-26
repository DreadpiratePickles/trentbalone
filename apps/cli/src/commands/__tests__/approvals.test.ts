/**
 * [W3.1 item 2] `trent approvals`.
 *
 * C5 parks a memory write made from untrusted context as a durable approval row and exports
 * `approveHeldMemoryWrite` to release it — and no surface called either one, so a held write was a
 * row in `gateway.json` that nothing could list and nobody could decide. This is the scriptable
 * door: `list` shows the run approvals and the held writes together, `approve` replays the seat's
 * own action with the provenance recorded, `reject` discards it and leaves the decided row behind.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT } from "@trent/core/errors/index.js";
import { FileGatewayStore } from "@trent/core/gateway/index.js";
import { holdMemoryWrite } from "@trent/core/tools/index.js";
// [H1] auto review: the reviewer is driven here with a fake model; the CLI only lists and reverses.
import { approvalAuditPath } from "@trent/core/governance/auto-review-audit.js";
import { AutoReviewConfigSchema } from "@trent/core/governance/auto-review-config.js";
import { reviewHeldApprovals, type ReviewGateway } from "@trent/core/governance/auto-review.js";
import { createBoundApprovalStore, type BoundCall } from "@trent/core/governance/bound-approvals.js";
import { runCli } from "../index.js";

const ACTION = 'memory {"action":"add","content":"the vendor page lists net-30 terms"}';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-approvals-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function json<T>(argv: readonly string[]): Promise<T> {
  const result = await runCli([...argv, "--json"]);
  expect(result.exitCode, result.stderr || result.stdout).toBe(EXIT.OK);
  return JSON.parse(result.stdout) as T;
}

/** The one thing every case needs: a parked untrusted write in this profile. */
function hold(sources: readonly string[] = ["web_extract"]): string {
  return holdMemoryWrite({ profileDir: home, adapter: "memory", action: ACTION, sources, seat: "finance", runId: "run-1", stepId: "step-a" }).id;
}

function blockText(): string {
  const file = path.join(home, "memories", "MEMORY.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

interface HeldJson {
  id: string;
  kind: string;
  tool: string;
  seat: string;
  tools: string[];
  runId: string | null;
}
interface ListJson {
  pending: { id: string; action: string; agentId: string }[];
  held: HeldJson[];
}

describe("trent approvals", () => {
  it("list names every held write's kind, seat and the untrusted tools it came from", async () => {
    const id = hold(["web_extract", "browser_get_text"]);

    const listed = await json<ListJson>(["approvals", "list"]);

    expect(listed.held.map((row) => row.id)).toEqual([id]);
    expect(listed.held[0]).toMatchObject({ kind: "memory", tool: "memory", seat: "finance", runId: "run-1" });
    expect(listed.held[0]?.tools).toEqual(["web_extract", "browser_get_text"]);
    // A held write is not counted among the ordinary run approvals; it has its own decision path.
    expect(listed.pending.map((row) => row.id)).not.toContain(id);

    const human = await runCli(["approvals", "list"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain(id);
    expect(human.stdout).toContain("web_extract");
  });

  it("approve lands the write with the provenance recorded in the entry itself", async () => {
    const id = hold();
    expect(blockText()).toBe("");

    const approved = await json<{ id: string; status: string; provenance: string }>(["approvals", "approve", id]);

    expect(approved).toMatchObject({ id, status: "approved", provenance: "untrusted" });
    expect(blockText()).toContain("net-30 terms");
    expect(blockText()).toContain("[provenance: untrusted via web_extract]");
    expect((await json<ListJson>(["approvals", "list"])).held).toEqual([]);

    // The row is decided, so the same id cannot be replayed into the block a second time.
    const again = await runCli(["approvals", "approve", id, "--json"]);
    expect(again.exitCode).not.toBe(EXIT.OK);
  });

  it("reject discards the write and leaves the decided row behind as the record of the refusal", async () => {
    const id = hold();

    const rejected = await json<{ id: string; status: string }>(["approvals", "reject", id]);

    expect(rejected).toMatchObject({ id, status: "denied" });
    expect(blockText()).toBe("");
    expect((await json<ListJson>(["approvals", "list"])).held).toEqual([]);

    const row = new FileGatewayStore(path.join(home, "gateway.json")).snapshot().approvals[id];
    expect(row?.status).toBe("denied");
    expect(row?.decidedAt).toBeTruthy();
    expect(row?.decidedBy).toBeTruthy();
  });

  it("--dry-run reports what would be decided and writes nothing, the way every id command does", async () => {
    const id = hold();

    const dry = await json<{ dryRun: boolean; command: string; id: string }>(["approvals", "approve", id, "--dry-run"]);
    expect(dry).toMatchObject({ dryRun: true, command: "approvals approve", id });

    expect(blockText()).toBe("");
    expect((await json<ListJson>(["approvals", "list"])).held.map((row) => row.id)).toEqual([id]);
  });

  it("refuses an id no held write and no approval row answers to", async () => {
    const missing = await runCli(["approvals", "approve", "appr_nothing", "--json"]);
    expect(missing.exitCode).not.toBe(EXIT.OK);
    expect(missing.stdout + missing.stderr).toContain("appr_nothing");
  });
});

// [H1] auto review ───────────────────────────────────────────────────────────────────────────────

const REVIEW_MODEL = "qwen3.5:9b";
const REVIEW_ACTOR = `auto-review:${REVIEW_MODEL}`;

function smsCall(body: string): BoundCall {
  const args = { to: "+15550100", from: "+15550000", body };
  return { adapter: "business", action: `sms_send ${JSON.stringify(args)}`, tool: "sms_send", args, seat: "support", classes: ["external_send", "customer_facing"] };
}
const SMS = smsCall("Your table is booked for 7pm tonight.");
// [C3] A reviewer decides only read and write calls (the ceiling is write), so the call it decides here is a
// write the owner put on the class floor; the SMS is what it must leave for a person.
function noteCall(content: string): BoundCall {
  const args = { path: "notes/opening-hours.md", content };
  return { adapter: "file_ops", action: `write_file ${JSON.stringify(args)}`, tool: "write_file", args, seat: "support", classes: ["write"] };
}
const NOTE = noteCall("Open until 10pm on Fridays.");
const previewOf = (call: BoundCall): string =>
  call.tool === "write_file" ? `Write notes/opening-hours.md: ${(call.args as { content: string }).content}` : `SMS to +15550100: ${(call.args as { body: string }).body}`;
// [/C3]

/** Parks a floored call out of a seat turn, as the class floor does, and returns its row id. */
function park(call: BoundCall = NOTE): string { // [C3] NOTE
  const decision = createBoundApprovalStore({ profileDir: home }).require(call, previewOf(call));
  expect(decision.granted).toBe(false);
  return decision.row!.id;
}

/** One reviewer pass over this profile with a fake model answering `reply`; no call leaves the process. */
async function review(reply: Record<string, string>): Promise<void> {
  const gateway: ReviewGateway = {
    async complete() {
      return { text: JSON.stringify(reply), provider: "openai", model: REVIEW_MODEL, modelTier: "haiku", inputTokens: 1, outputTokens: 1, costCents: 0, estimated: false, priced_as_default: false, finishReason: "stop" };
    },
  };
  await reviewHeldApprovals({
    store: new FileGatewayStore(path.join(home, "gateway.json")),
    profileDir: home,
    policy: AutoReviewConfigSchema.parse({ enabled: true, model: REVIEW_MODEL, max_class: "write", recipients: ["+15550100"] }), // [C3] the ceiling
    hardline: { home, profileDir: home },
    gateway: async () => gateway,
  });
}

function writeConfig(governance: string[]): void {
  fs.writeFileSync(path.join(home, "config.yaml"), ["version: 3", "profile: default", "provider: openai", "model: gpt-5.6-terra", "governance:", "  auto_review:", ...governance.map((line) => `    ${line}`), ""].join("\n"));
}

interface ReviewedJson {
  id: string;
  status: string;
  actor: string;
  reason: string;
  ran: boolean;
}
interface ReviewListJson {
  pending: { id: string; review?: { decision: string; actor: string; reason: string; rule?: string } }[];
  reviewed: ReviewedJson[];
  review?: { outcomes: { id: string; decision: string; rule?: string; modelCalled: boolean }[] };
  policy?: Record<string, unknown>;
}

describe("trent approvals and the auto reviewer [H1]", () => {
  it("list shows every reviewer decision with its actor and reason, and how to reverse an approval that has not run", async () => {
    const id = park();
    await review({ decision: "approve", reason: "a booking confirmation to an allowlisted number" });

    const listed = await json<ReviewListJson>(["approvals", "list"]);

    expect(listed.pending.map((row) => row.id)).not.toContain(id);
    expect(listed.reviewed).toEqual([expect.objectContaining({ id, status: "approved", actor: REVIEW_ACTOR, reason: "a booking confirmation to an allowlisted number", ran: false })]);
    const human = await runCli(["approvals", "list"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain(REVIEW_ACTOR);
    expect(human.stdout).toContain(`trent approvals reject ${id}`);
  });

  it("list shows an escalated call as still pending, with the reviewer's reason", async () => {
    const id = park();
    await review({ decision: "escalate", reason: "unsure whether the customer asked for this" });

    const listed = await json<ReviewListJson>(["approvals", "list"]);

    expect(listed.pending).toEqual([expect.objectContaining({ id, review: expect.objectContaining({ decision: "escalate", actor: REVIEW_ACTOR, reason: "unsure whether the customer asked for this" }) })]);
    expect(listed.reviewed).toEqual([]);
  });

  it("list --review refuses while governance.auto_review is off, and changes nothing", async () => {
    park();
    const before = fs.readFileSync(path.join(home, "gateway.json"));

    const refused = await runCli(["approvals", "list", "--review", "--json"]);

    expect(refused.exitCode).toBe(EXIT.CONFIG);
    expect(refused.stdout + refused.stderr).toContain("governance.auto_review.enabled");
    expect(fs.readFileSync(path.join(home, "gateway.json")).equals(before)).toBe(true);
    expect(fs.existsSync(approvalAuditPath(home))).toBe(false);
  });

  it("list --review escalates a call above the policy's ceiling without asking any model", async () => {
    writeConfig(["enabled: true", "max_class: write", "recipients: ['+15550100']"]);
    const id = park(SMS); // [C3] an SMS is above every ceiling a config may hold

    const listed = await json<ReviewListJson>(["approvals", "list", "--review"]);

    expect(listed.review?.outcomes).toEqual([expect.objectContaining({ id, decision: "escalate", rule: "class_above_max", modelCalled: false })]);
    expect(listed.pending).toEqual([expect.objectContaining({ id, review: expect.objectContaining({ decision: "escalate", actor: "auto-review:policy", rule: "class_above_max" }) })]);
  });

  it("list --policy prints the written policy", async () => {
    writeConfig(["enabled: true", `model: ${REVIEW_MODEL}`, "max_class: write", "max_amount_cents: 5000", "currency: USD", "recipients: ['*@example.com']"]); // [C3] write is the ceiling

    const listed = await json<ReviewListJson>(["approvals", "list", "--policy"]);

    expect(listed.policy).toEqual({ enabled: true, model: REVIEW_MODEL, max_class: "write", max_amount_cents: 5000, currency: "usd", recipients: ["*@example.com"] });
  });

  it("reject reverses an auto-approved call that has not run, and refuses one that already ran", async () => {
    const waiting = park();
    const later = noteCall("Open until 11pm on Saturdays."); // [C3] a second write, another key
    const ran = park(later);
    await review({ decision: "approve", reason: "allowlisted number, booking text" });
    expect(createBoundApprovalStore({ profileDir: home }).require(later, previewOf(later)).granted).toBe(true);

    const reversed = await json<{ id: string; status: string; reversed: boolean }>(["approvals", "reject", waiting]);
    expect(reversed).toMatchObject({ id: waiting, status: "denied", reversed: true });
    expect(new FileGatewayStore(path.join(home, "gateway.json")).snapshot().approvals[waiting]).toMatchObject({ status: "denied", decidedBy: "human" });

    const refused = await runCli(["approvals", "reject", ran, "--json"]);
    expect(refused.exitCode).not.toBe(EXIT.OK);
    expect(refused.stdout + refused.stderr).toContain("already ran");
  });
});
