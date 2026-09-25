import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import { EmailAdapter } from "./email.js";
import { GatewayManager } from "../GatewayManager.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeSmtpServer, FakeImapServer, type FakeImapMessage } from "../testing/fakeMail.js";
import { waitFor } from "../testing/fakeServer.js";
import type { InboundMessage } from "../transport/types.js";

/** The receiving MTA's authserv-id; its Authentication-Results header is the topmost one. */
const MTA = "mx.example.com";
const DMARC_PASS = `${MTA}; spf=pass smtp.mailfrom=ops@example.com; dmarc=pass (p=REJECT) header.from=example.com`;
const DMARC_FAIL = `${MTA}; spf=fail smtp.mailfrom=mallory@evil.example; dkim=none; dmarc=fail (p=REJECT) header.from=example.com`;

/** One RFC 5322 message as the fake IMAP server stores it: `auth` lines go on top, as an MTA prepends them. */
function mail(uid: number, opts: { from?: string; auth?: string[]; text?: string } = {}): FakeImapMessage {
  const lines = [
    ...(opts.auth ?? []).map((a) => `Authentication-Results: ${a}`),
    `From: ${opts.from ?? "Ada <ops@example.com>"}`,
    `Subject: Secret plan ${uid}`,
    `Message-ID: <m${uid}@example.com>`,
    "Date: Tue, 14 Nov 2023 22:13:20 +0000",
  ];
  return { uid, headers: `${lines.join("\r\n")}\r\n\r\n`, text: opts.text ?? `do the thing ${uid}\r\n` };
}

describe("EmailAdapter against local SMTP and IMAP servers", () => {
  let smtp: FakeSmtpServer;
  let imap: FakeImapServer;
  let adapter: EmailAdapter;
  let store: MemoryGatewayStore;
  let settings: Record<string, string>;

  beforeEach(async () => {
    smtp = new FakeSmtpServer();
    imap = new FakeImapServer();
    await smtp.start();
    await imap.start();
    store = new MemoryGatewayStore();
    settings = {
      EMAIL_SMTP_HOST: "127.0.0.1", EMAIL_SMTP_PORT: String(smtp.port), EMAIL_SMTP_USER: "bot@example.com", EMAIL_SMTP_PASS: "s3cret", EMAIL_SMTP_SECURITY: "none",
      EMAIL_IMAP_HOST: "127.0.0.1", EMAIL_IMAP_PORT: String(imap.port), EMAIL_IMAP_SECURITY: "none",
      EMAIL_FROM: "Trent <bot@example.com>", EMAIL_POLL_INTERVAL_MS: "50",
    };
    adapter = new EmailAdapter({ config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }), store, settings });
  });

  afterEach(async () => {
    await adapter.stop();
    await smtp.stop();
    await imap.stop();
  });

  it("submits over SMTP with EHLO/AUTH PLAIN/MAIL/RCPT/DATA and a threaded RFC 5322 message", async () => {
    expect(adapter.isConfigured()).toBe(true);
    const receipt = await adapter.send({ channelId: "ops@example.com", text: "Deploy?\nReply APPROVE.", threadId: "<orig-1@example.com>", metadata: { subject: "Approval needed" } });
    expect(receipt.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
    expect(smtp.commands).toEqual(["EHLO trent.local", "AUTH PLAIN <credentials>", "MAIL FROM:<bot@example.com>", "RCPT TO:<ops@example.com>", "DATA", "QUIT"]);
    const [mail] = smtp.mails;
    expect(mail.from).toBe("<bot@example.com>");
    expect(mail.to).toEqual(["<ops@example.com>"]);
    const headers = mail.data.split("\r\n\r\n")[0];
    expect(headers).toContain("From: Trent <bot@example.com>");
    expect(headers).toContain("To: ops@example.com");
    expect(headers).toContain("Subject: Re: Approval needed");
    expect(headers).toContain("In-Reply-To: <orig-1@example.com>");
    expect(headers).toContain("References: <orig-1@example.com>");
    expect(headers).toContain(`Message-ID: ${receipt.messageId}`);
    expect(headers).toContain("Content-Type: text/plain; charset=utf-8");
    const body = mail.data.split("\r\n\r\n")[1];
    expect(Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")).toBe("Deploy?\nReply APPROVE.");
  });

  it("polls IMAP for unseen mail, strips quoted history, marks seen, and remembers the UID", async () => {
    imap.messages = [{
      uid: 7,
      headers: `Authentication-Results: ${DMARC_PASS}\r\nFrom: Ada <ops@example.com>\r\nSubject: Re: Approval needed\r\nMessage-ID: <reply-1@example.com>\r\nIn-Reply-To: <orig-1@example.com>\r\nDate: Tue, 14 Nov 2023 22:13:20 +0000\r\n\r\n`,
      text: "APPROVE appr_1 abcdef12\r\n\r\n> On Tue, Trent wrote:\r\n> Deploy?\r\n",
    }];
    const inbound: InboundMessage[] = [];
    adapter.onMessage(async (m) => { inbound.push(m); });
    await adapter.start();
    await waitFor(() => inbound.length === 1);
    expect(inbound[0]).toEqual(expect.objectContaining({
      id: "<reply-1@example.com>", platform: "email", channelId: "ops@example.com", senderId: "ops@example.com", senderName: "Ada",
      content: "APPROVE appr_1 abcdef12", scope: "dm", threadId: "<orig-1@example.com>", timestamp: "2023-11-14T22:13:20.000Z",
    }));
    expect(inbound[0].metadata).toEqual(expect.objectContaining({ subject: "Re: Approval needed" }));
    // The MTA's verdict headers are fetched with the rest; nothing else about the wire changes.
    expect(imap.commands.slice(0, 4)).toEqual(["LOGIN <credentials>", 'SELECT "INBOX"', "UID SEARCH UNSEEN", "UID FETCH 7 (BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES AUTHENTICATION-RESULTS RECEIVED-SPF)] BODY.PEEK[TEXT])"]);
    expect(imap.commands).toContain("UID STORE 7 +FLAGS (\\Seen)");
    expect(imap.messages[0].seen).toBe(true);
    expect(store.snapshot().cursors["email.uid"]).toBe("7");
    // A later poll must not re-deliver.
    await new Promise((r) => setTimeout(r, 150));
    expect(inbound).toHaveLength(1);
    expect((await adapter.health()).state).toBe("up");
  });

  describe("inbound mail needs an authenticated From before pairing or routing", () => {
    let manager: GatewayManager | undefined;
    let tempDir: string | undefined;
    let seen: InboundMessage[];
    let warnings: Array<{ message: string; fields?: Record<string, unknown> }>;

    beforeEach(() => {
      seen = [];
      warnings = [];
    });

    afterEach(async () => {
      await manager?.stopAll();
      manager = undefined;
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    });

    /** The real gateway core over the real adapter; `pollOnce` drives one IMAP round deterministically. */
    function gateway(config = new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" })) {
      manager = new GatewayManager(config, {
        store: new MemoryGatewayStore(),
        agentHandler: async (_agentId, m) => { seen.push(m); return `on it: ${m.content}`; },
        adapterContext: { settings, logger: { info() {}, warn: (message, fields) => { warnings.push({ message, fields }); } } },
      });
      return { manager, email: manager.getAdapter("email") as EmailAdapter };
    }

    /** A real config.yaml on disk carrying a `gateway.email` override, read back by a fresh manager. */
    function configWith(email: { require_authenticated_from?: boolean; authserv_id?: string }): ConfigManager {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-email-auth-"));
      const config = new ConfigManager({ baseDir: tempDir });
      const current = config.loadConfig();
      config.saveConfig({ ...current, gateway: { ...current.gateway, email: { ...current.gateway.email, ...email } } });
      return new ConfigManager({ baseDir: tempDir });
    }

    it("a message whose Authentication-Results says dmarc=fail is never handed to the message handler and never issues a pairing code", async () => {
      const { manager: m, email } = gateway();
      m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "admin" });
      imap.messages = [
        mail(1, { from: "Ada <ops@example.com>", auth: [DMARC_FAIL] }), // a spoof of the paired admin
        mail(2, { from: "Stranger <stranger@example.com>", auth: [DMARC_FAIL] }), // an unknown sender
      ];
      expect(await email.pollOnce()).toBe(2);
      expect(seen).toEqual([]);
      expect(m.getPairing().listPendingCodes()).toEqual([]);
      expect(smtp.mails).toEqual([]);
      expect(imap.messages.every((x) => x.seen)).toBe(true); // consumed once, never retried
      // One line per refusal, naming the address and the verdict, never the subject or the body.
      expect(warnings.map((w) => w.fields)).toEqual([
        { from: "ops@example.com", verdict: expect.stringContaining("dmarc=fail") },
        { from: "stranger@example.com", verdict: expect.stringContaining("dmarc=fail") },
      ]);
      expect(JSON.stringify(warnings)).not.toMatch(/Secret plan|do the thing/);

      // Control: the same harness does see a pairing code when the verdict is a pass.
      imap.messages.push(mail(3, { from: "Newcomer <newcomer@example.com>", auth: [DMARC_PASS] }));
      await email.pollOnce();
      expect(m.getPairing().listPendingCodes()).toEqual([expect.objectContaining({ platform: "email", senderId: "newcomer@example.com" })]);
      expect(smtp.mails.map((x) => x.to)).toEqual([["<newcomer@example.com>"]]);
    });

    it("dmarc=pass from a paired sender is handled as today", async () => {
      const { manager: m, email } = gateway();
      m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "regular" });
      imap.messages = [mail(4, { from: "Ada <ops@example.com>", auth: [DMARC_PASS] })];
      await email.pollOnce();
      expect(seen).toEqual([expect.objectContaining({ platform: "email", senderId: "ops@example.com", channelId: "ops@example.com", senderName: "Ada", content: "do the thing 4", scope: "dm" })]);
      expect(smtp.mails).toHaveLength(1);
      expect(smtp.mails[0].to).toEqual(["<ops@example.com>"]);
      expect(warnings).toEqual([]);
    });

    it("no Authentication-Results header at all is refused by default", async () => {
      const { manager: m, email } = gateway();
      m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "admin" });
      imap.messages = [mail(5, { from: "Ada <ops@example.com>" })];
      await email.pollOnce();
      expect(seen).toEqual([]);
      expect(smtp.mails).toEqual([]);
      expect(warnings.map((w) => w.fields)).toEqual([{ from: "ops@example.com", verdict: expect.stringMatching(/no Authentication-Results/i) }]);
    });

    it("spf=pass with an aligned envelope domain and no dmarc verdict is accepted; spf=pass with an unaligned domain is refused", async () => {
      const { manager: m, email } = gateway();
      m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "regular" });
      imap.messages = [
        mail(6, { auth: [`${MTA}; spf=pass smtp.mailfrom=bounces+6@mail.example.com`] }),
        mail(7, { auth: [`${MTA}; spf=pass smtp.mailfrom=mallory@evil.example`] }),
      ];
      await email.pollOnce();
      expect(seen.map((x) => x.content)).toEqual(["do the thing 6"]);
      expect(warnings.map((w) => w.fields)).toEqual([{ from: "ops@example.com", verdict: expect.stringContaining("evil.example") }]);
    });

    it("trusts only the topmost Authentication-Results: a pass the sender wrote below the MTA's fail changes nothing", async () => {
      const { manager: m, email } = gateway();
      m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "admin" });
      imap.messages = [mail(8, { auth: [DMARC_FAIL, DMARC_PASS] })];
      await email.pollOnce();
      expect(seen).toEqual([]);
      expect(warnings.map((w) => w.fields)).toEqual([{ from: "ops@example.com", verdict: expect.stringContaining("dmarc=fail") }]);
    });

    it("with the opt-out config set, the old behaviour returns", async () => {
      const { manager: m, email } = gateway(configWith({ require_authenticated_from: false }));
      m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "regular" });
      imap.messages = [mail(9, { auth: [DMARC_FAIL] }), mail(10)];
      await email.pollOnce();
      expect(seen.map((x) => x.content)).toEqual(["do the thing 9", "do the thing 10"]);
      expect(warnings).toEqual([]);
    });

    it("a sender-supplied dmarc=pass header above the server's dmarc=fail is ignored when authserv_id names the server", async () => {
      const { manager: m, email } = gateway(configWith({ authserv_id: "MX.Example.com" })); // matched case-insensitively
      m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "admin" });
      imap.messages = [mail(13, { auth: ["forged.example; dmarc=pass header.from=example.com", DMARC_FAIL] })];
      await email.pollOnce();
      expect(seen).toEqual([]);
      expect(warnings.map((w) => w.fields)).toEqual([{ from: "ops@example.com", verdict: "dmarc=fail" }]);
      // The server's own pass counts even with a forged fail written above it.
      imap.messages.push(mail(14, { auth: ["forged.example; dmarc=fail header.from=example.com", DMARC_PASS] }));
      await email.pollOnce();
      expect(seen.map((x) => x.content)).toEqual(["do the thing 14"]);
    });

    it("a message with no header from the named server is refused", async () => {
      const { manager: m, email } = gateway(configWith({ authserv_id: "mx.example.com" }));
      m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "admin" });
      imap.messages = [mail(15, { auth: ["forged.example; dmarc=pass header.from=example.com"] }), mail(16)];
      await email.pollOnce();
      expect(seen).toEqual([]);
      expect(warnings.map((w) => w.fields)).toEqual([
        { from: "ops@example.com", verdict: "no Authentication-Results from mx.example.com" },
        { from: "ops@example.com", verdict: "no Authentication-Results from mx.example.com" },
      ]);
    });

    it("unset: topmost header is used as today", async () => {
      const { manager: m, email } = gateway();
      m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "admin" });
      // Without authserv_id nothing says which header is the server's, so the topmost one decides,
      // even when it is the sender's own: the reason docs/gateway.md recommends setting it.
      imap.messages = [mail(17, { auth: ["forged.example; dmarc=pass header.from=example.com", DMARC_FAIL] })];
      await email.pollOnce();
      expect(seen.map((x) => x.content)).toEqual(["do the thing 17"]);
      expect(warnings).toEqual([]);
    });

    it("an APPROVE <id> <nonce> reply goes through the same gate: a spoofed one decides nothing, an authenticated one decides", async () => {
      const { manager: m, email } = gateway();
      m.getPairing().grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "admin" });
      const bridge = m.getApprovalBridge();
      const req = bridge.createApprovalRequest("ceo", "Refund", {});
      const reply = `APPROVE ${req.id} ${req.nonce}\r\n`;
      imap.messages = [mail(11, { auth: [DMARC_FAIL], text: reply })];
      await email.pollOnce();
      expect(bridge.getApproval(req.id)?.status).toBe("pending");
      expect(smtp.mails).toEqual([]);
      imap.messages.push(mail(12, { auth: [DMARC_PASS], text: reply }));
      await email.pollOnce();
      expect(bridge.getApproval(req.id)).toEqual(expect.objectContaining({ status: "approved", decidedBy: "email:ops@example.com" }));
      expect(seen).toEqual([]); // a decision is never an objective for the agent
    });
  });
});
