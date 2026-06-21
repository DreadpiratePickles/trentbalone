type DevLoginEnv = {
  NODE_ENV?: string;
  TRENT_ENABLE_DEV_LOGIN?: string;
  NEXT_PUBLIC_ENABLE_DEV_LOGIN?: string;
  TRENT_LOGIN_ALLOWED_EMAILS?: string;
  TRENT_FOUNDER_EMAIL?: string;
  FOUNDER_EMAIL?: string;
  TRENT_ADMIN_EMAIL?: string;
  ADMIN_EMAIL?: string;
  AUTH_GOOGLE_ID?: string;
  AUTH_GOOGLE_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export function isDevelopmentLoginEnabled(env: DevLoginEnv = process.env): boolean {
  if (env.TRENT_ENABLE_DEV_LOGIN === "1") return true;
  if (env.NEXT_PUBLIC_ENABLE_DEV_LOGIN === "true") return true;
  return env.NODE_ENV !== "production";
}

export function productionLoginAllowedEmails(env: DevLoginEnv = process.env): string[] {
  const raw = [
    env.TRENT_LOGIN_ALLOWED_EMAILS,
    env.TRENT_FOUNDER_EMAIL,
    env.FOUNDER_EMAIL,
    env.TRENT_ADMIN_EMAIL,
    env.ADMIN_EMAIL,
  ]
    .filter(Boolean)
    .join(",");
  return Array.from(new Set(
    raw
      .split(/[,\s]+/)
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.includes("@")),
  ));
}

export function isCredentialsLoginEnabled(env: DevLoginEnv = process.env): boolean {
  return isDevelopmentLoginEnabled(env) || productionLoginAllowedEmails(env).length > 0;
}

export function isEmailAllowedForCredentialsLogin(email: string, env: DevLoginEnv = process.env): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  if (isDevelopmentLoginEnabled(env)) return true;
  return productionLoginAllowedEmails(env).includes(normalized);
}

export function hasGoogleAuthProvider(env: DevLoginEnv = process.env): boolean {
  const clientId = env.AUTH_GOOGLE_ID || env.GOOGLE_CLIENT_ID;
  const clientSecret = env.AUTH_GOOGLE_SECRET || env.GOOGLE_CLIENT_SECRET;
  return Boolean(clientId && clientSecret);
}
