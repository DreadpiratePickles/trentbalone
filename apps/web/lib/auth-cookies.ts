export function usesSecureAuthCookies(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.AUTH_URL?.startsWith("https://") === true ||
    process.env.NEXTAUTH_URL?.startsWith("https://") === true
  );
}

export function authSessionCookieName(): string {
  return usesSecureAuthCookies() ? "__Secure-authjs.session-token" : "authjs.session-token";
}
