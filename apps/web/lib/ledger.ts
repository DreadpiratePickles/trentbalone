import { store } from "@/lib/store";
import type { LedgerEntry } from "@/lib/types";

export class LedgerImbalanceError extends Error {
  constructor(debitCents: number, creditCents: number) {
    super(`Ledger imbalance: debits (${debitCents}¢) must equal credits (${creditCents}¢)`);
    this.name = "LedgerImbalanceError";
  }
}

export class LedgerDoublePostError extends Error {
  constructor(txHash: string) {
    super(`Transaction already posted: ${txHash}`);
    this.name = "LedgerDoublePostError";
  }
}

type EntryInput = {
  type: "debit" | "credit";
  account: string;
  amountCents: number;
  description: string;
};

export async function recordTransaction(
  companyId: string,
  txHash: string,
  entries: EntryInput[]
): Promise<void> {
  const debitTotal = entries
    .filter(e => e.type === "debit")
    .reduce((sum, e) => sum + e.amountCents, 0);

  const creditTotal = entries
    .filter(e => e.type === "credit")
    .reduce((sum, e) => sum + e.amountCents, 0);

  if (debitTotal !== creditTotal) {
    throw new LedgerImbalanceError(debitTotal, creditTotal);
  }

  const existing = await store.listLedgerEntries(companyId);
  if (existing.some(e => e.txHash === txHash)) {
    throw new LedgerDoublePostError(txHash);
  }

  for (const entry of entries) {
    await store.createLedgerEntry({
      companyId,
      type: entry.type,
      account: entry.account as LedgerEntry["account"],
      amountCents: entry.amountCents,
      txHash,
      description: entry.description,
    });
  }
}
