import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { companySchema } from "@/lib/validators";
import { getAuthUser, unauthorized, createOwnerMembership, getUserCompanyIds } from "@/lib/session";
import { db } from "@/lib/db";

export async function GET() {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  // DB mode: filter companies to ones this user is a member of.
  if (process.env.DATABASE_URL) {
    const companyIds = await getUserCompanyIds(user.id);
    if (companyIds !== null) {
      const rows = await db.company.findMany({
        where: { id: { in: companyIds }, status: { not: "archived" } },
        orderBy: { createdAt: "desc" }
      });
      // Map Prisma rows through the store's public mapper by using getCompany per id
      // (simpler than duplicating the mapper here)
      const companies = await Promise.all(companyIds.map((id) => store.getCompany(id)));
      return NextResponse.json({
        companies: companies.filter(Boolean)
      });
    }
  }

  return NextResponse.json({ companies: await store.listCompanies() });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const parsed = companySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const company = await store.createCompany(parsed.data);

  // Create ownership membership in DB mode.
  await createOwnerMembership(user.id, company.id);

  return NextResponse.json({ company }, { status: 201 });
}
