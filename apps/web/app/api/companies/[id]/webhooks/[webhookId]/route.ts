import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { encryptWebhookSecret, generateWebhookSecret, recordWebhookAudit, toPublicWebhook } from "@/lib/webhooks";
import { updateWebhookSchema } from "@/lib/webhooks-schema";

type Params = { params: Promise<{ id: string; webhookId: string }> };

async function authorize(companyId: string) {
  const user = await getAuthUser();
  if (!user) return { response: unauthorized() };
  const check = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!check.ok) return { response: forbidden() };
  return { user };
}

/** GET /api/companies/:id/webhooks/:webhookId — one webhook plus its recent deliveries. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id: companyId, webhookId } = await params;
  const auth = await authorize(companyId);
  if (auth.response) return auth.response;
  return withRlsContext(companyId, async () => {
    const webhook = await store.getWebhook(companyId, webhookId);
    if (!webhook) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    const deliveries = (await store.listWebhookDeliveries(companyId, webhookId)).slice(-50).reverse();
    return NextResponse.json({ webhook: toPublicWebhook(webhook), deliveries });
  });
}

/**
 * PATCH /api/companies/:id/webhooks/:webhookId — update url/events/action/enabled.
 * `rotateSecret: true` issues a new secret, returned once as `secret`. Re-enabling
 * a webhook resets its consecutive failure counter.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const { id: companyId, webhookId } = await params;
  const auth = await authorize(companyId);
  if (auth.response) return auth.response;

  const parsed = updateWebhookSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues.map((issue) => issue.message) }, { status: 400 });
  }
  const { rotateSecret, ...patch } = parsed.data;
  const secret = rotateSecret ? generateWebhookSecret() : undefined;

  return withRlsContext(companyId, async () => {
    const webhook = await store.updateWebhook(companyId, webhookId, {
      ...patch,
      ...(secret ? { secretRef: encryptWebhookSecret(secret) } : {}),
      ...(patch.enabled === true ? { consecutiveFailures: 0 } : {}),
    });
    if (!webhook) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    const changed = Object.keys(patch).concat(secret ? ["secret"] : []).join(", ");
    await recordWebhookAudit(companyId, "user", "webhook.update", webhook.id, `Updated webhook ${webhook.id} (${changed})`);
    return NextResponse.json(secret ? { webhook: toPublicWebhook(webhook), secret } : { webhook: toPublicWebhook(webhook) });
  });
}

/** DELETE /api/companies/:id/webhooks/:webhookId */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id: companyId, webhookId } = await params;
  const auth = await authorize(companyId);
  if (auth.response) return auth.response;
  return withRlsContext(companyId, async () => {
    const deleted = await store.deleteWebhook(companyId, webhookId);
    if (!deleted) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    await recordWebhookAudit(companyId, "user", "webhook.delete", webhookId, `Deleted webhook ${webhookId}`);
    return NextResponse.json({ ok: true });
  });
}
