import { NextResponse } from "next/server";
import { handleStripeWebhook } from "@/lib/marketing/stripe-billing";

export async function POST(request: Request) {
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
