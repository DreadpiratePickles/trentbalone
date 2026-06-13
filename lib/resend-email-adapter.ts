import { Webhook } from "svix";
import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";
import type { ToolAdapter } from "@/lib/tools";
import type { Document, ToolCallRecord } from "@/lib/types";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type ResendEmailAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
};

export type ResendInboundEmailEvent = {
  type: "email.received";
  emailId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  createdAt?: string;
  messageId?: string;
  attachments: Array<Record<string, unknown>>;
};

type DocumentStore = {
  createDocument(input: Omit<Document, "id" | "createdAt" | "version"> & { version?: number }): Promise<Document>;
};

const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";
const RESEND_DOMAINS_ENDPOINT = "https://api.resend.com/domains";
const APPROVAL_ACTIONS = ["send", "reply", "broadcast"];

export function createResendEmailAdapter(options: ResendEmailAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: "Email",
    scopes: [
      "resend:email:send",
      "resend:email:reply",
      "resend:inbound_email",
      "email:send_requires_approval",
    ],
    availability: "real",
    spendsMoneyOnExecute: true,
    async healthCheck() {
      const apiKey = resendToken(env);
      const senderDomain = resendSenderDomain(env);
      if (!apiKey || !senderDomain || !isHttpHeaderValueSafe(apiKey)) return "needs_credentials";
      try {
        const response = await fetchImpl(RESEND_DOMAINS_ENDPOINT, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
        });
        if (!response.ok) return "needs_credentials";
        const data = await readJson(response);
        const domains = Array.isArray(data?.data) ? data.data : [];
        if (!domains.length) return "connected";
        const matched = domains.find((domain) => {
          const record = asRecord(domain);
          return typeof record.name === "string" && resendDomainMatchesSender(senderDomain, record.name);
        });
        const status = typeof asRecord(matched).status === "string" ? String(asRecord(matched).status).toLowerCase() : "";
        return matched && (!status || status === "verified") ? "connected" : "needs_credentials";
      } catch {
        return "needs_credentials";
      }
    },
    estimateCost() {
      return 1;
    },
    requiresApproval(action) {
      return APPROVAL_ACTIONS.some((word) => action.toLowerCase().includes(word));
    },
    async execute(action, payload) {
      const apiKey = resendToken(env);
      if (!apiKey) {
        return failed(action, "Email is not configured. Set RESEND_AUTH_TOKEN or RESEND_API_KEY before agents can send real email.");
      }
      if (!isHttpHeaderValueSafe(apiKey)) {
        return failed(action, malformedCredentialSummary("Resend API key"));
      }
      if (this.requiresApproval(action) && typeof payload.approvalId !== "string") {
        return {
          adapter: "Email",
          action,
          status: "needs_approval",
          summary: `Email action "${action}" requires approval before Trent sends through Resend.`,
        };
      }

      const message = buildResendSendPayload(payload, env);
      if ("error" in message) return failed(action, message.error);

      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      const idempotencyKey = typeof payload.idempotencyKey === "string"
        ? payload.idempotencyKey
        : typeof payload.approvalId === "string"
          ? `trent:${payload.approvalId}:${action}`
          : undefined;
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey.slice(0, 256);

      try {
        const response = await fetchImpl(RESEND_EMAIL_ENDPOINT, {
          method: "POST",
          headers,
          body: JSON.stringify(message.payload),
        });
        const data = await readJson(response);
        if (!response.ok) {
          return failed(action, `Resend rejected email send (${response.status}): ${resendErrorMessage(data)}`);
        }
        const id = typeof data?.id === "string" ? data.id : "unknown";
        const recipients = Array.isArray(message.payload.to) ? message.payload.to.length : 1;
        return {
          adapter: "Email",
          action,
          status: "completed",
          summary: `Resend accepted email ${id} for delivery to ${recipients} recipient${recipients === 1 ? "" : "s"}.`,
        };
      } catch (error) {
        return failed(action, `Resend email send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async dryRun(action) {
      return {
        adapter: "Email",
        action,
        status: this.requiresApproval(action) ? "needs_approval" : "mocked",
        summary: `Email dry-run: Trent would prepare "${action}" for Resend after approval.`,
      };
    },
  };
}

export function resendToken(env: EnvLike = process.env): string | undefined {
  return firstNonEmpty(env.RESEND_AUTH_TOKEN, env.RESEND_API_KEY);
}

export function resendFromAddress(env: EnvLike = process.env): string | undefined {
  const explicit = firstNonEmpty(env.RESEND_FROM_EMAIL, env.TRENT_EMAIL_FROM, env.EMAIL_FROM);
  if (explicit) return explicit;
  const domain = firstNonEmpty(env.RESEND_FROM_DOMAIN, env.TRENT_EMAIL_DOMAIN, env.TRENT_PLATFORM_DOMAIN, env.BASE_DOMAIN);
  return domain ? `Trent <hello@${domain}>` : undefined;
}

function resendSenderDomain(env: EnvLike = process.env): string | undefined {
  const configuredDomain = firstNonEmpty(
    env.RESEND_FROM_DOMAIN,
    env.RESEND_INBOUND_DOMAIN,
    env.TRENT_EMAIL_DOMAIN,
    env.TRENT_PLATFORM_DOMAIN,
    env.BASE_DOMAIN,
  );
  if (configuredDomain) return configuredDomain.toLowerCase();
  const from = resendFromAddress(env);
  const parsed = from ? parseEmailAddress(from) : undefined;
  return parsed?.domain;
}

function resendDomainMatchesSender(senderDomain: string, verifiedDomain: string): boolean {
  const normalizedVerified = verifiedDomain.toLowerCase();
  return senderDomain === normalizedVerified || senderDomain.endsWith(`.${normalizedVerified}`);
}

export function verifyResendWebhookSignature(input: {
  payload: string;
  headers: Headers | Record<string, string | undefined>;
  secret: string;
}): boolean {
  try {
    const headers = input.headers instanceof Headers
      ? {
        "svix-id": input.headers.get("svix-id") ?? "",
        "svix-timestamp": input.headers.get("svix-timestamp") ?? "",
        "svix-signature": input.headers.get("svix-signature") ?? "",
      }
      : {
        "svix-id": input.headers["svix-id"] ?? "",
        "svix-timestamp": input.headers["svix-timestamp"] ?? "",
        "svix-signature": input.headers["svix-signature"] ?? "",
      };
    new Webhook(input.secret).verify(input.payload, headers);
    return true;
  } catch {
    return false;
  }
}

export function parseResendInboundEmailEvent(raw: unknown): ResendInboundEmailEvent {
  const event = asRecord(raw);
  if (event.type !== "email.received") {
    throw new Error(`Unsupported Resend webhook event "${String(event.type)}".`);
  }
  const data = asRecord(event.data);
  const emailId = stringField(data, "email_id") ?? stringField(data, "id");
  if (!emailId) throw new Error("Resend email.received event is missing data.email_id.");

  return {
    type: "email.received",
    emailId,
    from: stringField(data, "from") ?? "(unknown sender)",
    to: stringArrayField(data, "to"),
    cc: stringArrayField(data, "cc"),
    bcc: stringArrayField(data, "bcc"),
    subject: stringField(data, "subject") ?? "(no subject)",
    text: stringField(data, "text"),
    html: stringField(data, "html"),
    createdAt: stringField(data, "created_at") ?? stringField(event, "created_at"),
    messageId: stringField(data, "message_id"),
    attachments: Array.isArray(data.attachments)
      ? data.attachments.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      : [],
  };
}

export async function persistResendInboundEmail(input: {
  companyId: string;
  event: ResendInboundEmailEvent;
  store: DocumentStore;
}): Promise<Document> {
  return input.store.createDocument({
    companyId: input.companyId,
    type: "support_summary",
    title: `Inbound email: ${input.event.subject}`.slice(0, 180),
    content: formatInboundEmailDocument(input.event),
    source: `resend:email.received:${input.event.emailId}`,
    memoryTier: "episodic",
    validFrom: input.event.createdAt,
  });
}

export function extractCompanyKeyFromResendRecipients(event: ResendInboundEmailEvent, env: EnvLike = process.env): string | undefined {
  const allowedDomains = [
    env.RESEND_INBOUND_DOMAIN,
    env.TRENT_EMAIL_DOMAIN,
    env.RESEND_EMAIL_DOMAIN,
    env.RESEND_FROM_DOMAIN,
    env.TRENT_PLATFORM_DOMAIN,
    env.BASE_DOMAIN,
  ].filter((domain): domain is string => typeof domain === "string" && domain.trim().length > 0)
    .map((domain) => domain.trim().toLowerCase());
  if (!allowedDomains.length) return undefined;

  for (const recipient of event.to) {
    const parsed = parseEmailAddress(recipient);
    if (!parsed || !allowedDomains.includes(parsed.domain)) continue;
    const plusKey = parsed.local.match(/^(?:support|hello|founder|sales|team)\+([a-z0-9][a-z0-9_-]{1,80})$/i)?.[1];
    if (plusKey) return plusKey.toLowerCase();
    if (/^[a-z0-9][a-z0-9_-]{1,80}$/i.test(parsed.local)) return parsed.local.toLowerCase();
  }

  return undefined;
}

function buildResendSendPayload(payload: Record<string, unknown>, env: EnvLike): { payload: Record<string, unknown> } | { error: string } {
  const from = typeof payload.from === "string" && payload.from.trim() ? payload.from.trim() : resendFromAddress(env);
  if (!from) return { error: "Email send requires RESEND_FROM_EMAIL/TRENT_EMAIL_FROM/EMAIL_FROM, RESEND_FROM_DOMAIN/TRENT_PLATFORM_DOMAIN, or payload.from." };

  const to = emailRecipients(payload.to);
  if (!to.length) return { error: "Email send requires payload.to as an email address or list of addresses." };

  const subject = typeof payload.subject === "string" && payload.subject.trim() ? payload.subject.trim() : undefined;
  if (!subject) return { error: "Email send requires payload.subject." };

  const html = typeof payload.html === "string" && payload.html.trim() ? payload.html : undefined;
  const text = typeof payload.text === "string" && payload.text.trim()
    ? payload.text
    : typeof payload.body === "string" && payload.body.trim()
      ? payload.body
      : undefined;
  if (!html && !text && typeof payload.template !== "object") {
    return { error: "Email send requires payload.html, payload.text, payload.body, or payload.template." };
  }

  const body: Record<string, unknown> = { from, to, subject };
  if (html) body.html = html;
  if (text) body.text = text;
  if (typeof payload.replyTo === "string" && payload.replyTo.trim()) body.reply_to = payload.replyTo.trim();
  const cc = emailRecipients(payload.cc);
  const bcc = emailRecipients(payload.bcc);
  if (cc.length) body.cc = cc;
  if (bcc.length) body.bcc = bcc;
  if (Array.isArray(payload.tags)) body.tags = payload.tags;
  if (typeof payload.template === "object" && payload.template !== null) body.template = payload.template;
  return { payload: body };
}

function formatInboundEmailDocument(event: ResendInboundEmailEvent) {
  const lines = [
    "# Inbound Email",
    "",
    `Provider: Resend`,
    `Email ID: ${event.emailId}`,
    `Message ID: ${event.messageId ?? "(not provided)"}`,
    `Received At: ${event.createdAt ?? "(unknown)"}`,
    `From: ${event.from}`,
    `To: ${event.to.join(", ") || "(none)"}`,
    event.cc.length ? `Cc: ${event.cc.join(", ")}` : "",
    event.bcc.length ? `Bcc: ${event.bcc.join(", ")}` : "",
    `Subject: ${event.subject}`,
    "",
    "## Body",
    event.text ?? stripHtml(event.html) ?? "Body was not included in this webhook event. Retrieve full content from Resend's received-email API if needed.",
    "",
    "## Attachments",
    event.attachments.length
      ? event.attachments.map((attachment) => `- ${String(attachment.filename ?? attachment.id ?? "attachment")}`).join("\n")
      : "No attachments listed.",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: "Email", action, status: "failed", summary };
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const text = await response.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function resendErrorMessage(data: Record<string, unknown> | undefined) {
  const message = data?.message ?? data?.error;
  if (typeof message === "string") return message;
  if (message && typeof message === "object" && "message" in message && typeof message.message === "string") {
    return message.message;
  }
  return "unknown provider error";
}

function emailRecipients(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function stringArrayField(value: Record<string, unknown>, key: string) {
  return emailRecipients(value[key]);
}

function stringField(value: Record<string, unknown>, key: string) {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function parseEmailAddress(input: string): { local: string; domain: string } | undefined {
  const match = input.trim().match(/<?([^<>\s@]+)@([^<>\s@]+)>?$/);
  if (!match) return undefined;
  return { local: match[1].toLowerCase(), domain: match[2].toLowerCase() };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function stripHtml(html: string | undefined) {
  return html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
