export type StripeCustomerStatus = "pending" | "ready" | "blocked";

export type StripeCustomer = {
  id: string;
  companyId: string;
  stripeCustomerId: string;
  defaultPaymentMethodId?: string;
  offSessionMandateAcceptedAt?: string;
  status: StripeCustomerStatus;
  createdAt: string;
  updatedAt: string;
};

export type StripeSubscription = {
  id: string;
  companyId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: string;
  trialEndsAt?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  createdAt: string;
  updatedAt: string;
};

export type StripeWebhookEventStatus = "processing" | "succeeded" | "failed";

export type StripeWebhookEvent = {
  id: string;
  stripeEventId: string;
  eventType: string;
  status: StripeWebhookEventStatus;
  processedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};
