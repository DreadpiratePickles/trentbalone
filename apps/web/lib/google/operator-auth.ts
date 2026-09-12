// Operator-level authorization for platform-wide connections (e.g. the
// operator's own Gmail/Calendar). Unlike company routes, these are not scoped to
// a company membership. An allow-list of operator emails gates access; it fails
// closed in production when unset, and falls back to the dev bypass (mirroring
// canAccessCompany) only when there is no database configured.

export function isOperator(email: string | null | undefined): boolean {
  if (!email) return false;
  const configured = process.env.OPERATOR_EMAILS?.trim();
  if (configured) {
    const allowed = configured.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    return allowed.includes(email.toLowerCase());
  }
  // No allow-list configured: allow in dev (no database), deny in production.
  return !process.env.DATABASE_URL;
}
