import { NextResponse } from "next/server";
import { handleStripeWebhook } from "@/lib/marketing/stripe-billing";
import { checkPublicRateLimit, ipFromHeaders, rateLimitExceeded } from "@/lib/rate-limit";

export async function POST(request: Request) {
  const limit = await checkPublicRateLimit(ipFromHeaders(request.headers), "webhook:stripe");
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe signature" }, { status: 400 });
  }

  const rawBody = await request.text();
  try {
    const result = await handleStripeWebhook(rawBody, signature);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Invalid Stripe webhook" }, { status: 400 });
  }
}
