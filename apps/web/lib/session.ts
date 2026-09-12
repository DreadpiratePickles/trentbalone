import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { store } from "@/lib/store";
import { type Role, roleAtLeast } from "@/lib/rbac";

export type AuthUser = {
  id: string;
  email: string;
  name?: string | null;
};

/**
 * Returns the authenticated user from the current request's session,
 * or null if the request is unauthenticated.
 *
 * Call this at the top of every API route handler.
 */
export async function getAuthUser(): Promise<AuthUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name
  };
}

/**
 * Returns a 401 Unauthorized JSON response.
 */
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Returns a 403 Forbidden JSON response.
 */
export function forbidden(): NextResponse {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/**
 * Checks whether a user is a member of the given company.
 *
 * - In DB mode  (DATABASE_URL set): checks the CompanyMember table.
 * - In dev mode (no DATABASE_URL):  always returns true so the in-memory
 *   demo works without any setup.
 */
export async function canAccessCompany(userId: string, companyId: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return true;
  try {
    const member = await db.companyMember.findUnique({
      where: { companyId_userId: { companyId, userId } }
    });
    return !!member;
  } catch {
    return false;
  }
}

/**
 * Creates a CompanyMember row linking `userId` to `companyId` as owner.
 * No-ops in dev mode (no DATABASE_URL).
 */
export async function createOwnerMembership(userId: string, companyId: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await db.companyMember.create({
      data: {
        id: `member_${userId}_${companyId}`,
        companyId,
        userId,
        role: "owner",
        permissions: ["*"]
      }
    });
  } catch {
    // Swallow duplicate-key errors (idempotent).
  }
}

/**
 * Lists all company IDs the user is a member of.
 * Returns null in dev mode (caller should use store.listCompanies() directly).
 */
export async function getUserCompanyIds(userId: string): Promise<string[] | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const rows = await db.companyMember.findMany({
      where: { userId },
      select: { companyId: true }
    });
    return rows.map((r) => r.companyId);
  } catch {
    return null;
  }
}

export type RoleCheck = { ok: true; role: Role } | { ok: false; reason: "no_membership" | "insufficient_role" };

export async function requireRole(userId: string, companyId: string, minRole: Role): Promise<RoleCheck> {
  const actual = await store.getMemberRole(userId, companyId);
  if (actual === null) return { ok: false, reason: "no_membership" };
  if (!roleAtLeast(actual, minRole)) return { ok: false, reason: "insufficient_role" };
  return { ok: true, role: actual as Role };
}

export async function requireRoleForRequest(
  userId: string,
  minRole: Role,
  target:
    | { companyId: string }
    | { entityType: "task" | "artifact" | "recurring-task"; entityId: string }
): Promise<RoleCheck & { companyId?: string }> {
  let companyId: string | null = null;

  if ("companyId" in target) {
    companyId = target.companyId;
  } else {
    const { entityType, entityId } = target;
    switch (entityType) {
      case "task": {
        const task = await store.getTask(entityId);
        companyId = task?.companyId ?? null;
        break;
      }
      case "artifact": {
        const artifact = await store.getArtifact(entityId);
        companyId = artifact?.companyId ?? null;
        break;
      }
      case "recurring-task": {
        const template = await store.getRecurringTask(entityId);
        companyId = template?.companyId ?? null;
        break;
      }
    }
  }

  if (!companyId) {
    return { ok: false, reason: "no_membership" };
  }

  const check = await requireRole(userId, companyId, minRole);
  return { ...check, companyId };
}

