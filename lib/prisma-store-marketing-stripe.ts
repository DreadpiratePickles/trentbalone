import type {
  Prisma,
  StripeCustomer as PrismaStripeCustomer,
  StripeSubscription as PrismaStripeSubscription,
} from "@prisma/client";
import type { StripeCustomer, StripeSubscription } from "@/lib/types";
import { db } from "@/lib/db";
import { makeId } from "@/lib/utils";
import { toIso, toIsoReq } from "./prisma-store-mappers";

type StripeCustomerInput = Omit<StripeCustomer, "id" | "createdAt" | "updatedAt">;
type StripeSubscriptionInput = Omit<StripeSubscription, "id" | "createdAt" | "updatedAt">;

function mapStripeCustomer(row: PrismaStripeCustomer): StripeCustomer {
  return {
    id: row.id,
    companyId: row.companyId,
    stripeCustomerId: row.stripeCustomerId,
    defaultPaymentMethodId: row.defaultPaymentMethodId ?? undefined,
    offSessionMandateAcceptedAt: toIso(row.offSessionMandateAcceptedAt),
    status: row.status as StripeCustomer["status"],
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapStripeSubscription(row: PrismaStripeSubscription): StripeSubscription {
  return {
    id: row.id,
    companyId: row.companyId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripePriceId: row.stripePriceId,
    status: row.status,
    trialEndsAt: toIso(row.trialEndsAt),
    currentPeriodStart: toIso(row.currentPeriodStart),
    currentPeriodEnd: toIso(row.currentPeriodEnd),
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

export const prismaStoreMarketingStripe = {
  async upsertStripeCustomer(input: StripeCustomerInput): Promise<StripeCustomer> {
    const row = await db.stripeCustomer.upsert({
      where: { companyId: input.companyId },
      create: {
        id: makeId("stripe_customer"),
        companyId: input.companyId,
        stripeCustomerId: input.stripeCustomerId,
        defaultPaymentMethodId: input.defaultPaymentMethodId ?? null,
        offSessionMandateAcceptedAt: input.offSessionMandateAcceptedAt
          ? new Date(input.offSessionMandateAcceptedAt)
          : null,
        status: input.status,
      },
      update: {
        stripeCustomerId: input.stripeCustomerId,
        defaultPaymentMethodId: input.defaultPaymentMethodId ?? undefined,
        offSessionMandateAcceptedAt: input.offSessionMandateAcceptedAt
          ? new Date(input.offSessionMandateAcceptedAt)
          : undefined,
        status: input.status,
      },
    });
    return mapStripeCustomer(row);
  },

  async getStripeCustomer(companyId: string): Promise<StripeCustomer | null> {
    const row = await db.stripeCustomer.findUnique({ where: { companyId } });
    return row ? mapStripeCustomer(row) : null;
  },

  async upsertStripeSubscription(input: StripeSubscriptionInput): Promise<StripeSubscription> {
    const row = await db.stripeSubscription.upsert({
      where: { companyId: input.companyId },
      create: {
        id: makeId("stripe_subscription"),
        companyId: input.companyId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripePriceId: input.stripePriceId,
        status: input.status,
        trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : null,
        currentPeriodStart: input.currentPeriodStart ? new Date(input.currentPeriodStart) : null,
        currentPeriodEnd: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null,
      },
      update: {
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripePriceId: input.stripePriceId,
        status: input.status,
        trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : null,
        currentPeriodStart: input.currentPeriodStart ? new Date(input.currentPeriodStart) : null,
        currentPeriodEnd: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null,
      },
    });
    return mapStripeSubscription(row);
  },

  async recordStripeWebhookEvent(stripeEventId: string, eventType: string): Promise<void> {
    if (await this.claimStripeWebhookEvent(stripeEventId, eventType)) {
      await this.markStripeWebhookEventSucceeded(stripeEventId);
    }
  },

  async claimStripeWebhookEvent(stripeEventId: string, eventType: string): Promise<boolean> {
    try {
      await db.stripeWebhookEvent.create({
        data: { id: makeId("stripe_webhook"), stripeEventId, eventType, status: "processing" },
      });
      return true;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const retry = await db.stripeWebhookEvent.updateMany({
        where: { stripeEventId, status: "failed" },
        data: {
          eventType,
          status: "processing",
          processedAt: null,
          lastError: null,
        },
      });
      return retry.count === 1;
    }
  },

  async markStripeWebhookEventSucceeded(stripeEventId: string): Promise<void> {
    await db.stripeWebhookEvent.update({
      where: { stripeEventId },
      data: {
        status: "succeeded",
        processedAt: new Date(),
        lastError: null,
      },
    });
  },

  async markStripeWebhookEventFailed(stripeEventId: string, errorMessage: string): Promise<void> {
    await db.stripeWebhookEvent.update({
      where: { stripeEventId },
      data: {
        status: "failed",
        processedAt: null,
        lastError: errorMessage.slice(0, 2000),
      },
    }).catch(async (err) => {
      if (isRecordNotFoundError(err)) return;
      throw err;
    });
  },

  async hasStripeWebhookEvent(stripeEventId: string): Promise<boolean> {
    const event = await db.stripeWebhookEvent.findUnique({ where: { stripeEventId } });
    return event?.status === "succeeded" || event?.status === "processing";
  },
};

function isUniqueConstraintError(err: unknown) {
  return typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as Prisma.PrismaClientKnownRequestError).code === "P2002";
}

function isRecordNotFoundError(err: unknown) {
  return typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as Prisma.PrismaClientKnownRequestError).code === "P2025";
}
