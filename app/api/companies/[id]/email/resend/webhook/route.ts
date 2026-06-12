import { NextResponse } from "next/server";
import { parseResendInboundEmailEvent, persistResendInboundEmail, verifyResendWebhookSignature } from "@/lib/resend-email-adapter";
import { store } from "@/lib/store";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
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
  const { id: companyId } = await context.params;
  const document = await persistResendInboundEmail({ companyId, event, store });
  return NextResponse.json({ ok: true, documentId: document.id });
}
