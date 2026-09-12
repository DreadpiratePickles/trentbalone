import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import { withRlsContext } from "@/lib/with-rls";
import { getStripeClient, type StripeEvent } from "./stripe-client";

type StripeObject = Record<string, unknown> & {
  customer?: string | { id?: string };
  payment_method?: string | { id?: string };
  metadata?: Record<string, string>;
};

export async function createOffSessionSetupIntent(companyId: string): Promise<{ clientSecret: string }> {
  const company = await store.getCompany(companyId);
  if (!company) throw new Error("Company not found");

  const stripe = getStripeClient();
  const existing = await store.getStripeCustomer(company.id);
  const stripeCustomerId = existing?.stripeCustomerId ?? await createStripeCustomer(company.id, company.name);
  const setupIntent = await stripe.setupIntents.create({
    customer: stripeCustomerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: { companyId: company.id },
  });

  if (!setupIntent.client_secret) throw new Error("Stripe SetupIntent did not return a client secret");
  return { clientSecret: setupIntent.client_secret };
}

export async function markPaymentMethodReady(
  companyId: string,
  stripeCustomerId: string,
  paymentMethodId: string
) {
  await store.upsertStripeCustomer({
    companyId,
    stripeCustomerId,
    defaultPaymentMethodId: paymentMethodId,
    offSessionMandateAcceptedAt: nowIso(),
    status: "ready",
  });
}

export async function handleStripeWebhook(rawBody: string, signature: string): Promise<{ processed: boolean }> {
  const event = getStripeClient().webhooks.constructEvent(rawBody, signature);
  if (!await store.claimStripeWebhookEvent(event.id, event.type)) return { processed: false };

  try {
    await processStripeEvent(event);
    await store.markStripeWebhookEventSucceeded(event.id);
    return { processed: true };
  } catch (err) {
    await store.markStripeWebhookEventFailed(event.id, errorMessage(err));
    throw err;
  }
}

async function createStripeCustomer(companyId: string, companyName: string) {
  const customer = await getStripeClient().customers.create({
    metadata: { companyId },
    name: companyName,
  });
  await store.upsertStripeCustomer({
    companyId,
    stripeCustomerId: customer.id,
    status: "pending",
  });
  return customer.id;
}

async function processStripeEvent(event: StripeEvent) {
  const object = event.data.object as StripeObject;
  if (event.type === "setup_intent.succeeded") {
    const companyId = object.metadata?.companyId;
    const stripeCustomerId = idFromStripeRef(object.customer);
    const paymentMethodId = idFromStripeRef(object.payment_method);
    if (companyId && stripeCustomerId && paymentMethodId) {
      await withRlsContext(companyId, () =>
        markPaymentMethodReady(companyId, stripeCustomerId, paymentMethodId)
      );
    }
    return;
  }

  if (event.type === "payment_intent.payment_failed" || event.type === "payment_intent.requires_action") {
    const companyId = object.metadata?.companyId;
    const stripeCustomerId = idFromStripeRef(object.customer);
    if (companyId && stripeCustomerId) {
      await withRlsContext(companyId, () =>
        store.upsertStripeCustomer({
          companyId,
          stripeCustomerId,
          status: "blocked",
        })
      );
    }
  }
}

function idFromStripeRef(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
