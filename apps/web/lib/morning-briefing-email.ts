import type { Company, Report } from "@/lib/types";
import { createResendEmailAdapter, resendToken } from "@/lib/resend-email-adapter";

export type MorningBriefingDelivery = {
  status: "sent" | "skipped" | "failed";
  summary: string;
};

export async function deliverMorningBriefingEmail(input: {
  company: Company;
  report: Report;
  outcomeSnapshot?: string[];
  findings: string[];
  recommendations: string[];
}): Promise<MorningBriefingDelivery> {
  if (!resendToken(process.env)) {
    return {
      status: "skipped",
      summary: "Morning briefing email skipped: Resend is not configured.",
    };
  }
  const recipient = resolveMorningBriefingRecipient(process.env);
  if (!recipient) {
    return {
      status: "skipped",
      summary: "Morning briefing email skipped: founder recipient is not configured.",
    };
  }

  const adapter = createResendEmailAdapter();
  const result = await adapter.execute("send morning founder email", {
    approvalId: `system:${input.report.id}`,
    idempotencyKey: `morning-briefing:${input.report.id}`,
    to: recipient,
    subject: input.report.title,
    text: renderMorningBriefingText(input),
    html: renderMorningBriefingHtml(input),
  });

  if (result.status === "completed") {
    return {
      status: "sent",
      summary: `${result.summary} Recipient: ${recipient}.`,
    };
  }
  return {
    status: "failed",
    summary: `Morning briefing email failed: ${result.summary}`,
  };
}

export function resolveMorningBriefingRecipient(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = firstNonEmpty(
    env.MORNING_DIGEST_RECIPIENT,
    env.TRENT_FOUNDER_EMAIL,
    env.FOUNDER_EMAIL,
    env.TRENT_ADMIN_EMAIL,
    env.ADMIN_EMAIL,
  );
  if (explicit) return explicit;

  const domain = normalizedEmailDomain(firstNonEmpty(
    env.TRENT_PLATFORM_DOMAIN,
    env.BASE_DOMAIN,
    env.RESEND_INBOUND_DOMAIN,
    env.RESEND_FROM_DOMAIN,
    env.TRENT_EMAIL_DOMAIN,
  ));
  return domain ? `admin@${domain}` : undefined;
}

function renderMorningBriefingText(input: {
  company: Company;
  report: Report;
  outcomeSnapshot?: string[];
  findings: string[];
  recommendations: string[];
}) {
  return [
    input.report.title,
    "",
    `Company: ${input.company.name}`,
    "",
    ...(input.outcomeSnapshot?.length ? [...input.outcomeSnapshot, ""] : []),
    "What happened",
    ...input.findings.map((finding) => `- ${finding}`),
    "",
    "Next",
    ...input.recommendations.map((recommendation) => `- ${recommendation}`),
  ].join("\n");
}

function renderMorningBriefingHtml(input: {
  company: Company;
  report: Report;
  outcomeSnapshot?: string[];
  findings: string[];
  recommendations: string[];
}) {
  return [
    `<h1>${escapeHtml(input.report.title)}</h1>`,
    `<p><strong>Company:</strong> ${escapeHtml(input.company.name)}</p>`,
    ...(input.outcomeSnapshot?.length ? [
      "<h2>Outcome snapshot</h2>",
      `<pre>${escapeHtml(input.outcomeSnapshot.join("\n"))}</pre>`,
    ] : []),
    "<h2>What happened</h2>",
    `<ul>${input.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join("")}</ul>`,
    "<h2>Next</h2>",
    `<ul>${input.recommendations.map((recommendation) => `<li>${escapeHtml(recommendation)}</li>`).join("")}</ul>`,
  ].join("");
}

function normalizedEmailDomain(value: string | undefined) {
  if (!value) return undefined;
  const withoutProtocol = value.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return withoutProtocol.replace(/^send\./i, "").replace(/^mail\./i, "").toLowerCase();
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
