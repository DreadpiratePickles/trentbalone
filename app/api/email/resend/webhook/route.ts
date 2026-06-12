import { NextResponse } from "next/server";
import {
  extractCompanyKeyFromResendRecipients,
  parseResendInboundEmailEvent,
  persistResendInboundEmail,
  verifyResendWebhookSignature,
} from "@/lib/resend-email-adapter";
import { store } from "@/lib/store";

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({
      error: "RESEND_WEBHOOK_SECRET is not configured. Add the Resend webhook signing secret before enabling inbound email.",
    }, { status: 503 });
  }

  const payload = await request.text();
  if (!verifyResendWebhookSignature({ payload, headers: request.headers, secret })) {
    return NextResponse.json({ error: "Invalid Resend webhook signature." }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(payload) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const event = parseResendInboundEmailEvent(raw);
  const companyKey = extractCompanyKeyFromResendRecipients(event);
  if (!companyKey) {
    return NextResponse.json({
      ok: false,
      reason: "No configured company address matched this Resend inbound email.",
    }, { status: 202 });
  }

  const company = await store.getCompany(companyKey);
  if (!company) {
    return NextResponse.json({
      ok: false,
      reason: `No company matched inbound email key "${companyKey}".`,
    }, { status: 202 });
  }

  const document = await persistResendInboundEmail({ companyId: company.id, event, store });
  return NextResponse.json({ ok: true, companyId: company.id, documentId: document.id });
}
