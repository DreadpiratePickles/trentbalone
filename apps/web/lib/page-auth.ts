import { notFound, redirect } from "next/navigation";
import { getAuthUser, requireRoleForRequest } from "@/lib/session";
import type { AuthUser } from "@/lib/session";
import type { Role } from "@/lib/rbac";

type CompanyPageAccess = {
  user: AuthUser;
  role: Role;
  companyId: string;
};

export async function requireCompanyPageAccess(
  companyId: string,
  minRole: Role = "viewer"
): Promise<CompanyPageAccess> {
  const user = await getAuthUser();
  if (!user) {
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(`/companies/${companyId}`)}`);
  }

  const check = await requireRoleForRequest(user.id, minRole, { companyId });
  if (!check.ok) {
    notFound();
  }

  return {
    user,
    role: check.role,
    companyId: check.companyId ?? companyId,
  };
}
