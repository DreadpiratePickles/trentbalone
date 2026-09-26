/**
 * [C7] `trent gateway pair | pairings | revoke`, driven through `runCli` against the REAL
 * `GatewayManager` and a fake Telegram Bot API. The manager runs in webhook mode, so every inbound
 * update enters through the adapter's own `handleWebhook` in Telegram's wire shape, and it is started
 * on the command's profile, so it holds the gateway lock and the writer registration exactly as
 * `trent gateway start` does. The commands write the profile's `gateway.json` through the same store
 * path `trent approvals approve` uses, while that gateway runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { FileGatewayStore, GatewayManager } from "@trent/core/gateway/index.js";
import { FakeServer, json, waitFor } from "@trent/core/gateway/testing/fakeServer.js";
import { createBoundApprovalStore, type BoundCall } from "@trent/core/governance/bound-approvals.js";
import { liveGatewayHolder } from "@trent/core/profile/locks.js";
import { runCli } from "../index.js";

/** The local Bot API server's path segment; a fixture string, not a credential. */
const TOKEN = "777:c7-fixture-bot-path";
const HOOK_SECRET = "c7-fixture-webhook-header";
const ADA = 555;

interface Pairings {
  paired: Array<{ platform: string; senderId: string; scope: string; tier: string; pairedAt: string }>;
  pending: Array<{ platform: string; senderId: string; scope: string; code: string; expiresAt: string }>;
}

let home: string;
let server: FakeServer;
let manager: GatewayManager | undefined;
let updateId = 0;

const sent = (): Array<{ chat_id: number; text: string }> => server.find("POST", `/bot${TOKEN}/sendMessage`).map((r) => r.json as { chat_id: number; text: string });
const profileDir = (): string => new ConfigManager({ profile: "default" }).getProfileDir();
const store = (): FileGatewayStore => new FileGatewayStore(path.join(profileDir(), "gateway.json"));

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-gateway-pair-"));
  process.env.TRENT_HOME = home;
  updateId = 0;
  server = new FakeServer();
  server
    .on("POST", `/bot${TOKEN}/getMe`, (_r, res) => json(res, 200, { ok: true, result: { id: 1, is_bot: true, first_name: "Trent", username: "trent_bot" } }))
    .on("POST", `/bot${TOKEN}/sendMessage`, (_r, res) => json(res, 200, { ok: true, result: { message_id: 500 + sent().length, chat: { id: ADA }, date: 1, text: "x" } }));
  await server.start();
});

afterEach(async () => {
  await manager?.stopAll();
  manager = undefined;
  await server.stop();
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

/** The real manager on the command's profile, started: it now holds the profile's gateway lock. */
async function startGateway(seen: string[]): Promise<GatewayManager> {
  manager = new GatewayManager(new ConfigManager({ profile: "default" }), {
    agentHandler: async (_agentId, message) => {
      seen.push(message.content);
      return null;
    },
    adapterContext: {
      baseUrls: { telegram: server.baseUrl },
      settings: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: HOOK_SECRET, TELEGRAM_WEBHOOK_URL: "https://bot.example.test/webhooks/telegram" },
    },
    drainIntervalMs: 60_000,
  });
  expect(await manager.startAllConfigured()).toContain("telegram");
  expect(liveGatewayHolder(profileDir())?.pid).toBe(process.pid);
  return manager;
}

async function post(update: Record<string, unknown>): Promise<void> {
  const adapter = manager!.getAdapter("telegram")!;
  const response = await adapter.handleWebhook!({ method: "POST", url: "/webhooks/telegram", headers: { "x-telegram-bot-api-secret-token": HOOK_SECRET }, body: JSON.stringify(update) });
  expect(response.status).toBe(200);
}

const say = (text: string): Promise<void> => {
  updateId += 1;
  return post({ update_id: updateId, message: { message_id: updateId, from: { id: ADA, first_name: "Ada" }, chat: { id: ADA, type: "private" }, date: 1_700_000_000, text } });
};

const react = (messageId: number, emoji: string): Promise<void> => {
  updateId += 1;
  return post({ update_id: updateId, message_reaction: { chat: { id: ADA, type: "private" }, message_id: messageId, user: { id: ADA, first_name: "Ada" }, date: 1_700_000_100, old_reaction: [], new_reaction: [{ type: "emoji", emoji }] } });
};

const liveCode = (): string => store().snapshot().pairingCodes.find((c) => c.senderId === String(ADA) && c.expiresAt > Date.now())!.code;

describe("trent gateway pair, pairings and revoke while the gateway runs", () => {
  it("pairs the sender who received the code as an admin; their next message reaches the agent and their reaction decides a card with no JSON in it", async () => {
    const seen: string[] = [];
    await startGateway(seen);
    await say("hello trent");
    await waitFor(() => sent().length === 1);
    expect(seen).toEqual([]);
    const code = liveCode();

    const paired = await runCli(["gateway", "pair", "telegram", code, "--admin", "--json"]);
    expect(paired.exitCode, paired.stdout).toBe(EXIT.OK);
    expect(JSON.parse(paired.stdout)).toMatchObject({ platform: "telegram", senderId: "555", scope: "dm", tier: "admin" });

    await say("summarise yesterday");
    expect(seen).toEqual(["summarise yesterday"]);

    const args = { path: "notes/today.md", content: "standup notes" };
    const call: BoundCall = { adapter: "file_ops", action: `write_file ${JSON.stringify(args)}`, tool: "write_file", args, classes: ["local_write"], seat: "ceo" };
    const row = createBoundApprovalStore({ profileDir: profileDir() }).require(call, "write notes/today.md (13 bytes)").row!;
    await manager!.sendApproval(row, "telegram", String(ADA));
    await waitFor(() => sent().length === 2);
    const card = sent()[1]!.text;
    expect(card).not.toContain("{");
    expect(card).toContain("write_file");
    expect(card).toContain("notes/today.md");
    expect(card).toContain(`Ref: ${row.id}`);

    const delivered = store().snapshot().approvals[row.id]!.deliveredTo![0]!;
    await react(Number(delivered.messageId), "\u{1F44D}");
    expect(store().snapshot().approvals[row.id]).toMatchObject({ status: "approved", decidedBy: "telegram:555" });
  });

  it("pairings lists the live code and then the paired sender, never a credential; revoke unpairs, and their next message gets a code again", async () => {
    const seen: string[] = [];
    await startGateway(seen);
    await say("hi");
    await waitFor(() => sent().length === 1);

    const before = await runCli(["gateway", "pairings", "--json"]);
    expect(before.exitCode, before.stdout).toBe(EXIT.OK);
    const pending = (JSON.parse(before.stdout) as Pairings).pending;
    expect(pending).toEqual([expect.objectContaining({ platform: "telegram", senderId: "555", scope: "dm", code: liveCode() })]);
    expect(before.stdout).not.toContain(TOKEN);
    expect(before.stdout).not.toContain(HOOK_SECRET);
    // The stranger's own reply carries that code and names no command.
    expect(sent()[0]!.text).toContain(pending[0]!.code);
    expect(sent()[0]!.text).not.toContain("trent ");

    const paired = await runCli(["gateway", "pair", "telegram", pending[0]!.code.toLowerCase(), "--json"]);
    expect(paired.exitCode, paired.stdout).toBe(EXIT.OK);
    expect(JSON.parse(paired.stdout)).toMatchObject({ senderId: "555", tier: "regular" });
    const after = JSON.parse((await runCli(["gateway", "pairings", "--json"])).stdout) as Pairings;
    expect(after.paired).toEqual([expect.objectContaining({ platform: "telegram", senderId: "555", scope: "dm", tier: "regular" })]);
    expect(after.pending).toEqual([]);

    const revoked = await runCli(["gateway", "revoke", "telegram", "555", "--json"]);
    expect(revoked.exitCode, revoked.stdout).toBe(EXIT.OK);
    expect(JSON.parse(revoked.stdout)).toMatchObject({ platform: "telegram", senderId: "555", removed: 1 });
    expect((JSON.parse((await runCli(["gateway", "pairings", "--json"])).stdout) as Pairings).paired).toEqual([]);

    await say("still there?");
    await waitFor(() => sent().length === 2);
    expect(seen).toEqual([]);
    const fresh = liveCode();
    expect(fresh).not.toBe(pending[0]!.code);
    expect(sent()[1]!.text).toContain(fresh);
  });
});

describe("trent gateway pair, pairings and revoke refusals", () => {
  const errorOf = (stdout: string): { code: number; message: string } => (JSON.parse(stdout) as { error: { code: number; message: string } }).error;

  it("an unknown or expired code exits 2 and pairs nobody", async () => {
    const unknown = await runCli(["gateway", "pair", "telegram", "ZZZZ2345", "--json"]);
    expect(unknown.exitCode).toBe(EXIT.USAGE);
    expect(errorOf(unknown.stdout).message).toMatch(/unknown or expired pairing code/);

    const now = Date.now();
    store().mutate((s) => {
      s.pairingCodes.push({ code: "OLDC2345", platform: "telegram", senderId: "777", scope: "dm", issuedAt: now - 2 * 3_600_000, expiresAt: now - 3_600_000 });
    });
    const expired = await runCli(["gateway", "pair", "telegram", "OLDC2345", "--admin", "--json"]);
    expect(expired.exitCode).toBe(EXIT.USAGE);
    expect(errorOf(expired.stdout).message).toMatch(/unknown or expired pairing code/);
    expect(store().snapshot().pairings).toEqual([]);
  });

  it("an unknown platform, or a revoke of a sender who is not paired, exits 2 naming it", async () => {
    const platform = await runCli(["gateway", "pair", "carrier-pigeon", "ABCD2345", "--json"]);
    expect(platform.exitCode).toBe(EXIT.USAGE);
    expect(errorOf(platform.stdout).message).toMatch(/unknown platform carrier-pigeon/);
    const revoke = await runCli(["gateway", "revoke", "telegram", "999", "--json"]);
    expect(revoke.exitCode).toBe(EXIT.USAGE);
    expect(errorOf(revoke.stdout).message).toMatch(/no telegram sender 999 is paired/);
  });

  it("each answers --json --dry-run with exit 0 in an empty profile and writes nothing", async () => {
    for (const argv of [["gateway", "pair", "telegram", "ABCD2345", "--admin"], ["gateway", "pairings"], ["gateway", "revoke", "telegram", "555"]]) {
      const result = await runCli([...argv, "--json", "--dry-run"]);
      expect(result.exitCode, `${argv.join(" ")}: ${result.stdout}`).toBe(EXIT.OK);
      expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, command: argv.slice(0, 2).join(" ") });
    }
    expect(fs.existsSync(path.join(profileDir(), "gateway.json"))).toBe(false);
  });
});
