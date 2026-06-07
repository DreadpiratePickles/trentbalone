import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveAppBaseUrl } from "@/lib/app-base-url";

// In Phase 1 the referral program is tracked in-memory / mocked.
// Phase 2 will wire a Stripe Coupon + per-user referral table in Postgres.

function makeReferralCode(userId: string): string {
  // Deterministic short code from user id
  const hash = userId.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0x5f3759df);
  return hash.toString(36).toUpperCase().slice(-6).padStart(6, "T");
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = (session.user as { id?: string }).id ?? session.user.email ?? "anon";
  const code = makeReferralCode(userId);
  const baseUrl = resolveAppBaseUrl();

  // Mocked referral state — replace with DB query in Phase 2
  const referrals: Array<{ email: string; status: string; creditCents: number }> = [
    // { email: "alice@example.com", status: "pending", creditCents: 0 },
    // { email: "bob@example.com", status: "converted", creditCents: 9900 },
  ];

  const pendingCount = referrals.filter((r) => r.status === "pending").length;
  const convertedCount = referrals.filter((r) => r.status === "converted").length;
  const creditEarnedCents = referrals
    .filter((r) => r.status === "converted")
    .reduce((sum, r) => sum + r.creditCents, 0);

  return NextResponse.json({
    code,
    link: `${baseUrl}/?ref=${code}`,
    referrals,
    pendingCount,
    convertedCount,
    creditEarnedCents,
    creditPerReferralCents: 9900, // $99
  });
}
