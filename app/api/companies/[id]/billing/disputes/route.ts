import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { withRlsContext } from "@/lib/with-rls";
import { escalateDispute } from "@/lib/payments/dispute-handler";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: company.id });
  if (!check.ok) return forbidden();

  const body = await request.json().catch(() => ({}));
  const { txHash, amountCents, counterpartyWallet } = body;

  if (!txHash || amountCents == null || !counterpartyWallet) {
    return NextResponse.json(
      { error: "txHash, amountCents, and counterpartyWallet are required" },
      { status: 400 }
    );
  }

  return withRlsContext(company.id, async () => {
    const approval = await escalateDispute(company.id, txHash, amountCents, counterpartyWallet);
    return NextResponse.json({ approval }, { status: 201 });
  });
}
