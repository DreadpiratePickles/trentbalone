import { state } from "./mem-store-state";
import type { StripeCustomer, StripeSubscription, StripeWebhookEvent } from "./types";
import { makeId, nowIso } from "./utils";

type StripeCustomerInput = Omit<StripeCustomer, "id" | "createdAt" | "updatedAt">;
type StripeSubscriptionInput = Omit<StripeSubscription, "id" | "createdAt" | "updatedAt">;

export const memStoreMarketingStripe = {
  async upsertStripeCustomer(input: StripeCustomerInput): Promise<StripeCustomer> {
    const currentState = state();
    currentState.stripeCustomers ??= [];
    const timestamp = nowIso();
    const existing = currentState.stripeCustomers.find(customer => customer.companyId === input.companyId);
    if (existing) {
      Object.assign(existing, input, { updatedAt: timestamp });
      return existing;
    }

    const customer: StripeCustomer = {
      ...input,
      id: makeId("stripe_customer"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    currentState.stripeCustomers.push(customer);
    return customer;
  },

  async getStripeCustomer(companyId: string): Promise<StripeCustomer | null> {
    state().stripeCustomers ??= [];
    return state().stripeCustomers.find(customer => customer.companyId === companyId) ?? null;
  },

  async upsertStripeSubscription(input: StripeSubscriptionInput): Promise<StripeSubscription> {
    const currentState = state();
    currentState.stripeSubscriptions ??= [];
    const timestamp = nowIso();
    const existing = currentState.stripeSubscriptions.find(subscription => subscription.companyId === input.companyId);
    if (existing) {
      Object.assign(existing, input, { updatedAt: timestamp });
      return existing;
    }

    const subscription: StripeSubscription = {
      ...input,
      id: makeId("stripe_subscription"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    currentState.stripeSubscriptions.push(subscription);
    return subscription;
  },

  async recordStripeWebhookEvent(stripeEventId: string, eventType: string): Promise<void> {
    if (await this.claimStripeWebhookEvent(stripeEventId, eventType)) {
      await this.markStripeWebhookEventSucceeded(stripeEventId);
    }
  },

  async claimStripeWebhookEvent(stripeEventId: string, eventType: string): Promise<boolean> {
    const currentState = state();
    currentState.stripeWebhookEvents ??= [];
    const timestamp = nowIso();
    const existing = currentState.stripeWebhookEvents.find(
      (event) => event.stripeEventId === stripeEventId
    );
    if (existing) {
      if (existing.status !== "failed") return false;
      Object.assign(existing, {
        eventType,
        status: "processing",
        processedAt: undefined,
        lastError: undefined,
        updatedAt: timestamp,
      });
      return true;
    }

    const event: StripeWebhookEvent = {
      id: makeId("stripe_webhook"),
      stripeEventId,
      eventType,
      status: "processing",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    currentState.stripeWebhookEvents.push(event);
    return true;
  },

  async markStripeWebhookEventSucceeded(stripeEventId: string): Promise<void> {
    const event = state().stripeWebhookEvents.find(item => item.stripeEventId === stripeEventId);
    if (!event) return;
    const timestamp = nowIso();
    Object.assign(event, {
      status: "succeeded",
      processedAt: timestamp,
      lastError: undefined,
      updatedAt: timestamp,
    });
  },

  async markStripeWebhookEventFailed(stripeEventId: string, errorMessage: string): Promise<void> {
    const event = state().stripeWebhookEvents.find(item => item.stripeEventId === stripeEventId);
    if (!event) return;
    Object.assign(event, {
      status: "failed",
      processedAt: undefined,
      lastError: errorMessage,
      updatedAt: nowIso(),
    });
  },

  async hasStripeWebhookEvent(stripeEventId: string): Promise<boolean> {
    state().stripeWebhookEvents ??= [];
    const event = state().stripeWebhookEvents.find(item => item.stripeEventId === stripeEventId);
    return event?.status === "succeeded" || event?.status === "processing";
  },
};
