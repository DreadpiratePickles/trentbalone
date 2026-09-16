import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { encryptWebhookSecret, generateWebhookSecret, recordWebhookAudit, toPublicWebhook } from "@/lib/webhooks";
import { createWebhookSchema } from "@/lib/webhooks-schema";

/** GET /api/companies/:id/webhooks — list outbound webhooks (secret masked). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!check.ok) return forbidden();
  return withRlsContext(companyId, async () => {
    const webhooks = (await store.listWebhooks(companyId)).map(toPublicWebhook);
    return NextResponse.json({ webhooks });
  });
}

/**
 * POST /api/companies/:id/webhooks — create a webhook. The generated secret is
 * returned in this response only; afterwards it exists solely as ciphertext.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!check.ok) return forbidden();

  const parsed = createWebhookSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues.map((issue) => issue.message) }, { status: 400 });
  }

  const secret = generateWebhookSecret();
  return withRlsContext(companyId, async () => {
    const webhook = await store.createWebhook({
      companyId,
      url: parsed.data.url,
      events: parsed.data.events,
      action: parsed.data.action,
      enabled: parsed.data.enabled,
      secretRef: encryptWebhookSecret(secret),
    });
    await recordWebhookAudit(companyId, "user", "webhook.create", webhook.id, `Created webhook for ${new URL(webhook.url).host}`);
    return NextResponse.json({ webhook: toPublicWebhook(webhook), secret }, { status: 201 });
  });
}
