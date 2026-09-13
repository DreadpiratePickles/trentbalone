import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { EmailAdapter } from "./email.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { FakeSmtpServer, FakeImapServer } from "../testing/fakeMail.js";
import { waitFor } from "../testing/fakeServer.js";
import type { InboundMessage } from "../transport/types.js";

describe("EmailAdapter against local SMTP and IMAP servers", () => {
  let smtp: FakeSmtpServer;
  let imap: FakeImapServer;
  let adapter: EmailAdapter;
  let store: MemoryGatewayStore;

  beforeEach(async () => {
    smtp = new FakeSmtpServer();
    imap = new FakeImapServer();
    await smtp.start();
    await imap.start();
    store = new MemoryGatewayStore();
    adapter = new EmailAdapter({
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store,
      settings: {
        EMAIL_SMTP_HOST: "127.0.0.1", EMAIL_SMTP_PORT: String(smtp.port), EMAIL_SMTP_USER: "bot@example.com", EMAIL_SMTP_PASS: "s3cret", EMAIL_SMTP_SECURITY: "none",
        EMAIL_IMAP_HOST: "127.0.0.1", EMAIL_IMAP_PORT: String(imap.port), EMAIL_IMAP_SECURITY: "none",
        EMAIL_FROM: "Trent <bot@example.com>", EMAIL_POLL_INTERVAL_MS: "50",
      },
    });
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
      headers: "From: Ada <ops@example.com>\r\nSubject: Re: Approval needed\r\nMessage-ID: <reply-1@example.com>\r\nIn-Reply-To: <orig-1@example.com>\r\nDate: Tue, 14 Nov 2023 22:13:20 +0000\r\n\r\n",
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
    expect(imap.commands.slice(0, 4)).toEqual(["LOGIN <credentials>", 'SELECT "INBOX"', "UID SEARCH UNSEEN", "UID FETCH 7 (BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] BODY.PEEK[TEXT])"]);
    expect(imap.commands).toContain("UID STORE 7 +FLAGS (\\Seen)");
    expect(imap.messages[0].seen).toBe(true);
    expect(store.snapshot().cursors["email.uid"]).toBe("7");
    // A later poll must not re-deliver.
    await new Promise((r) => setTimeout(r, 150));
    expect(inbound).toHaveLength(1);
    expect((await adapter.health()).state).toBe("up");
  });
});
