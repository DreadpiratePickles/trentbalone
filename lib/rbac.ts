// Role hierarchy for company membership.
// Ordered least → most privileged; index = rank.
export const ROLES = ["viewer", "member", "admin", "owner"] as const;

export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = ROLES.reduce(
  (acc, role, index) => {
    acc[role] = index;
    return acc;
  },
  {} as Record<Role, number>
);

/** True if `value` is one of the known roles. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * True if `actual` is at least as privileged as `required`.
 * Unknown roles are treated as below everything (never satisfy a requirement).
 */
export function roleAtLeast(actual: unknown, required: Role): boolean {
  if (!isRole(actual)) return false;
  return RANK[actual] >= RANK[required];
}
