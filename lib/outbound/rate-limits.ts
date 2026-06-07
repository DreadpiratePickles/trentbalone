export type OutboundRateLimits = {
  recipientPerDay: number;
  domainPerDay: number;
  senderPerDay: number;
};

export function assertOutboundRateAllowed(input: {
  recipientCount24h: number;
  domainCount24h: number;
  senderCount24h: number;
  limits: OutboundRateLimits;
}): void {
  if (input.recipientCount24h >= input.limits.recipientPerDay) {
    throw new Error("Outbound recipient rate limit exceeded");
  }
  if (input.domainCount24h >= input.limits.domainPerDay) {
    throw new Error("Outbound domain rate limit exceeded");
  }
  if (input.senderCount24h >= input.limits.senderPerDay) {
    throw new Error("Outbound sender rate limit exceeded");
  }
}
