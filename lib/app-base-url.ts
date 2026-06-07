/** Public app base URL for links (referrals, OAuth callbacks in docs). */
export function resolveAppBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return "http://localhost:3000";
}
