import type {
  Invoice as PrismaInvoice,
  LedgerEntry as PrismaLedgerEntry,
  PayoutHold as PrismaPayoutHold
} from "@prisma/client";
import type { Invoice, LedgerEntry, PayoutHold } from "@/lib/types";
import { toIso, toIsoReq } from "./prisma-store-mappers";
import { db } from "@/lib/db";
import { makeId } from "@/lib/utils";

export function mapInvoice(row: PrismaInvoice): Invoice {
  return {
    id: row.id,
    companyId: row.companyId,
    billingPeriod: row.billingPeriod,
    amountCents: row.amountCents,
    status: row.status as Invoice["status"],
    createdAt: toIsoReq(row.createdAt),
    paidAt: toIso(row.paidAt),
    txHash: row.txHash ?? undefined,
    lineItems: row.lineItems
  };
}

export function mapLedgerEntry(row: PrismaLedgerEntry): LedgerEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as LedgerEntry["type"],
    account: row.account as LedgerEntry["account"],
    amountCents: row.amountCents,
    txHash: row.txHash,
    description: row.description,
    createdAt: toIsoReq(row.createdAt)
  };
}

export function mapPayoutHold(row: PrismaPayoutHold): PayoutHold {
  return {
    id: row.id,
    companyId: row.companyId,
    creatorWallet: row.creatorWallet,
    amountCents: row.amountCents,
    status: row.status as PayoutHold["status"],
    releaseAt: toIsoReq(row.releaseAt),
    reason: row.reason,
    createdAt: toIsoReq(row.createdAt),
    releasedAt: toIso(row.releasedAt)
  };
}

export const prismaStoreBilling = {
  async getInvoice(companyId: string, billingPeriod: string): Promise<Invoice | null> {
    const row = await db.invoice.findFirst({
      where: { companyId, billingPeriod }
    });
    return row ? mapInvoice(row) : null;
  },

  async createInvoice(input: Omit<Invoice, "id" | "createdAt" | "paidAt" | "txHash"> & { id?: string; createdAt?: string }): Promise<Invoice> {
    const row = await db.invoice.create({
      data: {
        id: input.id ?? makeId("invoice"),
        companyId: input.companyId,
        billingPeriod: input.billingPeriod,
        amountCents: input.amountCents,
        status: input.status,
        lineItems: input.lineItems as any,
        createdAt: input.createdAt ? new Date(input.createdAt) : new Date()
      }
    });
    return mapInvoice(row);
  },

  async listInvoices(companyId: string): Promise<Invoice[]> {
    const rows = await db.invoice.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapInvoice);
  },

  async updateInvoice(id: string, patch: Partial<Invoice>): Promise<Invoice | undefined> {
    const data: any = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.paidAt !== undefined) data.paidAt = patch.paidAt ? new Date(patch.paidAt) : null;
    if (patch.txHash !== undefined) data.txHash = patch.txHash;
    if (patch.lineItems !== undefined) data.lineItems = patch.lineItems;

    const row = await db.invoice.update({
      where: { id },
      data
    });
    return mapInvoice(row);
  },

  async createLedgerEntry(input: Omit<LedgerEntry, "id" | "createdAt">): Promise<LedgerEntry> {
    const row = await db.ledgerEntry.create({
      data: {
        id: makeId("ledger"),
        companyId: input.companyId,
        type: input.type,
        account: input.account,
        amountCents: input.amountCents,
        txHash: input.txHash,
        description: input.description
      }
    });
    return mapLedgerEntry(row);
  },

  async listLedgerEntries(companyId: string): Promise<LedgerEntry[]> {
    const rows = await db.ledgerEntry.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapLedgerEntry);
  },

  async createPayoutHold(input: Omit<PayoutHold, "id" | "createdAt" | "releasedAt">): Promise<PayoutHold> {
    const row = await db.payoutHold.create({
      data: {
        id: makeId("hold"),
        companyId: input.companyId,
        creatorWallet: input.creatorWallet,
        amountCents: input.amountCents,
        status: input.status,
        releaseAt: new Date(input.releaseAt),
        reason: input.reason
      }
    });
    return mapPayoutHold(row);
  },

  async getPayoutHold(id: string): Promise<PayoutHold | undefined> {
    const row = await db.payoutHold.findUnique({
      where: { id }
    });
    return row ? mapPayoutHold(row) : undefined;
  },

  async listPayoutHolds(companyId: string): Promise<PayoutHold[]> {
    const rows = await db.payoutHold.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapPayoutHold);
  },

  async updatePayoutHold(id: string, patch: Partial<PayoutHold>): Promise<PayoutHold | undefined> {
    const data: any = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.releasedAt !== undefined) data.releasedAt = patch.releasedAt ? new Date(patch.releasedAt) : null;
    if (patch.releaseAt !== undefined) data.releaseAt = patch.releaseAt ? new Date(patch.releaseAt) : null;
    if (patch.reason !== undefined) data.reason = patch.reason;

    const row = await db.payoutHold.update({
      where: { id },
      data
    });
    return mapPayoutHold(row);
  }
};
