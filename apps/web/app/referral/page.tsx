import { auth } from "@/lib/auth";
import { PortfolioShell } from "@/components/shell";
import { ReferralPageClient } from "@/components/referral-client";

export default async function ReferralPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  const userEmail = session?.user?.email ?? null;
  return (
    <PortfolioShell>
      <ReferralPageClient userId={userId} userEmail={userEmail} />
    </PortfolioShell>
  );
}
