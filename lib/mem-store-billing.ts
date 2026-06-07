import { state } from "./mem-store-state";
import { Invoice, LedgerEntry, PayoutHold } from "./types";
import { makeId, nowIso } from "./utils";

export const memStoreBilling = {
  async getInvoice(companyId: string, billingPeriod: string): Promise<Invoice | null> {
    if (!state().invoices) state().invoices = [];
    return state().invoices.find(inv => inv.companyId === companyId && inv.billingPeriod === billingPeriod) ?? null;
  },
  async createInvoice(input: Omit<Invoice, "id" | "createdAt" | "paidAt" | "txHash"> & { id?: string; createdAt?: string }): Promise<Invoice> {
    if (!state().invoices) state().invoices = [];
    const invoice: Invoice = {
      ...input,
      id: input.id ?? makeId("invoice"),
      createdAt: input.createdAt ?? nowIso(),
    };
    state().invoices.push(invoice);
    return invoice;
  },
  async listInvoices(companyId: string): Promise<Invoice[]> {
    if (!state().invoices) state().invoices = [];
    return state().invoices.filter(inv => inv.companyId === companyId);
  },
  async updateInvoice(id: string, patch: Partial<Invoice>): Promise<Invoice | undefined> {
    if (!state().invoices) state().invoices = [];
    const invoice = state().invoices.find(inv => inv.id === id);
    if (!invoice) return undefined;
    Object.assign(invoice, patch);
    return invoice;
  },
  async createLedgerEntry(input: Omit<LedgerEntry, "id" | "createdAt">): Promise<LedgerEntry> {
    if (!state().ledgerEntries) state().ledgerEntries = [];
    const entry: LedgerEntry = {
      ...input,
      id: makeId("ledger"),
      createdAt: nowIso()
    };
    state().ledgerEntries.push(entry);
    return entry;
  },
  async listLedgerEntries(companyId: string): Promise<LedgerEntry[]> {
    if (!state().ledgerEntries) state().ledgerEntries = [];
    return state().ledgerEntries.filter(entry => entry.companyId === companyId);
  },
  async createPayoutHold(input: Omit<PayoutHold, "id" | "createdAt" | "releasedAt">): Promise<PayoutHold> {
    if (!state().payoutHolds) state().payoutHolds = [];
    const hold: PayoutHold = {
      ...input,
      id: makeId("hold"),
      createdAt: nowIso()
    };
    state().payoutHolds.push(hold);
    return hold;
  },
  async getPayoutHold(id: string): Promise<PayoutHold | undefined> {
    if (!state().payoutHolds) state().payoutHolds = [];
    return state().payoutHolds.find(h => h.id === id);
  },
  async listPayoutHolds(companyId: string): Promise<PayoutHold[]> {
    if (!state().payoutHolds) state().payoutHolds = [];
    return state().payoutHolds.filter(h => h.companyId === companyId);
  },
  async updatePayoutHold(id: string, patch: Partial<PayoutHold>): Promise<PayoutHold | undefined> {
    if (!state().payoutHolds) state().payoutHolds = [];
    const hold = state().payoutHolds.find(h => h.id === id);
    if (!hold) return undefined;
    Object.assign(hold, patch);
    return hold;
  }
};
