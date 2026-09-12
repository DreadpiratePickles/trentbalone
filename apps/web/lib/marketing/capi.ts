import { createHash } from "node:crypto";
import { store } from "@/lib/store";
import { normalizeEventName } from "@/lib/marketing/events";
import { getMarketingPlatformAdapter } from "@/lib/marketing/platform-adapter";
import type { ConversionEvent, ConversionEventInput, ConversionEventName, MarketingAccount } from "./types";

type UserDataInput = {
  email?: unknown;
  phone?: unknown;
};

export type ServerEventInput = UserDataInput & {
  eventName: unknown;
  eventId: unknown;
  occurredAt: unknown;
  sourceUrl?: unknown;
  fbp?: unknown;
  fbc?: unknown;
};

export type BuiltServerEvent = Omit<ConversionEventInput, "companyId" | "deliveryStatus">;

export class ServerEventConsentRequiredError extends Error {
  constructor() {
    super("Server event consent is required");
    this.name = "ServerEventConsentRequiredError";
  }
}

export class ServerEventAccountNotFoundError extends Error {
  constructor() {
    super("Marketing account not found");
    this.name = "ServerEventAccountNotFoundError";
  }
}

export class ServerEventAccountConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerEventAccountConfigurationError";
  }
}

export class ServerEventConflictError extends Error {
  constructor() {
    super("Conversion event eventId already exists");
    this.name = "ServerEventConflictError";
  }
}

export function hashUserData(input: UserDataInput) {
  const hashed: Record<string, string> = {};
  const email = normalizedUserValue(input.email);
  const phone = normalizedUserValue(input.phone);
  if (email) hashed.em = sha256(email);
  if (phone) hashed.ph = sha256(phone);
  return hashed;
}

export function buildServerEvent(input: ServerEventInput): BuiltServerEvent {
  const eventId = requiredString(input.eventId, "eventId");
  const eventName = normalizeEventName(input.eventName);
  const occurredAt = normalizedIso(input.occurredAt);
  const hashedUserData = hashUserData(input);

  return {
    eventId,
    eventName,
    occurredAt,
    sourceUrl: optionalString(input.sourceUrl),
    fbp: optionalString(input.fbp),
    fbc: optionalString(input.fbc),
    hashedUserData,
    diagnostics: {
      pii: {
        email: Boolean(hashedUserData.em),
        phone: Boolean(hashedUserData.ph),
        normalization: "sha256_trim_lowercase_v1",
      },
      taxonomy: eventName,
    },
  };
}

export async function sendServerEvent(
  companyId: string,
  accountId: string,
  event: BuiltServerEvent
): Promise<ConversionEvent> {
  const existing = await requireMarketingStore().getConversionEventByEventId(event.eventId);
  if (existing) return existingForCompany(existing, companyId);

  const account = await findMarketingAccount(companyId, accountId);
  if (!account.consentForServerEvents) throw new ServerEventConsentRequiredError();

  const externalAccountId = account.externalAccountId.trim();
  if (!externalAccountId) {
    throw new ServerEventAccountConfigurationError("Marketing account externalAccountId is required");
  }

  const reserved = await reserveConversionEvent(companyId, event);
  const delivery = await deliverToProvider(companyId, account, event, externalAccountId);
  return requireMarketingStore().updateConversionEvent(reserved.id, {
    deliveryStatus: delivery.deliveryStatus,
    diagnostics: {
      ...event.diagnostics,
      delivery: delivery.diagnostics,
    },
  });
}

async function reserveConversionEvent(companyId: string, event: BuiltServerEvent) {
  try {
    return await requireMarketingStore().createConversionEvent({
      companyId,
      eventId: event.eventId,
      eventName: event.eventName,
      occurredAt: event.occurredAt,
      sourceUrl: event.sourceUrl,
      userAgentHash: event.userAgentHash,
      fbp: event.fbp,
      fbc: event.fbc,
      hashedUserData: event.hashedUserData,
      deliveryStatus: "pending",
      diagnostics: {
        ...event.diagnostics,
        delivery: { mode: "reserved" },
      },
    });
  } catch (error) {
    if (!isDuplicateEventIdError(error)) throw error;
    const existing = await requireMarketingStore().getConversionEventByEventId(event.eventId);
    if (existing) return existingForCompany(existing, companyId);
    throw error;
  }
}

function existingForCompany(existing: ConversionEvent, companyId: string) {
  if (existing.companyId !== companyId) throw new ServerEventConflictError();
  return existing;
}

async function findMarketingAccount(companyId: string, accountId: string) {
  const accounts = await requireMarketingStore().listMarketingAccounts(companyId);
  const account = accounts.find((item) => item.id === accountId && item.companyId === companyId);
  if (!account) throw new ServerEventAccountNotFoundError();
  return account;
}

async function deliverToProvider(
  companyId: string,
  account: MarketingAccount,
  event: BuiltServerEvent,
  externalAccountId: string
): Promise<{ deliveryStatus: ConversionEvent["deliveryStatus"]; diagnostics: Record<string, unknown> }> {
  try {
    const adapter = getMarketingPlatformAdapter(account.platform);
    const result = await adapter.sendConversionEvent({
      companyId,
      marketingAccountId: account.id,
      externalAccountId,
      eventId: event.eventId,
      eventName: event.eventName,
      occurredAt: event.occurredAt,
      hashedUserData: event.hashedUserData,
    });
    return {
      deliveryStatus: result.delivered ? "sent" : "pending",
      diagnostics: {
        provider: result.platform,
        providerStatus: result.status,
        delivered: result.delivered,
        mode: result.status === "sandbox" ? "sandbox" : "server_event",
      },
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "ProviderDeliveryError";
    return {
      deliveryStatus: "failed",
      diagnostics: {
        provider: account.platform,
        mode: name.includes("Unsupported") ? "unsupported" : "failed",
        errorName: name,
      },
    };
  }
}

function normalizedUserValue(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function requiredString(value: unknown, field: string) {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedIso(value: unknown) {
  const raw = requiredString(value, "occurredAt");
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error("occurredAt must be a valid ISO date");
  return date.toISOString();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function isDuplicateEventIdError(error: unknown) {
  if (error instanceof Error && error.message.includes("eventId already exists")) return true;
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

function requireMarketingStore() {
  const marketingStore = store as typeof store & {
    listMarketingAccounts(companyId: string): Promise<MarketingAccount[]>;
    getConversionEventByEventId(eventId: string): Promise<ConversionEvent | undefined>;
    createConversionEvent(input: ConversionEventInput): Promise<ConversionEvent>;
    updateConversionEvent(id: string, patch: Partial<ConversionEvent>): Promise<ConversionEvent>;
  };
  if (
    typeof marketingStore.listMarketingAccounts !== "function" ||
    typeof marketingStore.getConversionEventByEventId !== "function" ||
    typeof marketingStore.createConversionEvent !== "function" ||
    typeof marketingStore.updateConversionEvent !== "function"
  ) {
    throw new Error("Marketing CAPI store methods are not available");
  }
  return marketingStore;
}
