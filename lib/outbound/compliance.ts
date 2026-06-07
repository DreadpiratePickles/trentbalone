export function assertCanSpamCompliant(input: {
  body: string;
  senderName?: string;
  unsubscribeRequestedAt?: string;
  now?: string;
}): void {
  if (!input.senderName?.trim()) throw new Error("CAN-SPAM sender ID is required");
  if (!/\bunsubscribe\b/i.test(input.body)) throw new Error("CAN-SPAM opt-out link is required");
  if (!/\d+ .+/.test(input.body)) throw new Error("CAN-SPAM physical footer address is required");
  if (input.unsubscribeRequestedAt) {
    const now = Date.parse(input.now ?? new Date().toISOString());
    const requested = Date.parse(input.unsubscribeRequestedAt);
    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    if (now - requested >= tenDaysMs) throw new Error("Recipient is suppressed by CAN-SPAM opt-out window");
  }
}

export function assertGdprCompliant(input: {
  region: string;
  lawfulBasis?: "consent" | "legitimate_interest" | "contract";
  consentRecordedAt?: string;
  regionSuppressed: boolean;
}): void {
  if (input.regionSuppressed) throw new Error("Recipient is on a regional GDPR suppression list");
  if (input.region === "EU" || input.region === "UK") {
    if (!input.lawfulBasis) throw new Error("GDPR lawful basis is required");
    if (input.lawfulBasis === "consent" && !input.consentRecordedAt) {
      throw new Error("GDPR consent record is required");
    }
  }
}
