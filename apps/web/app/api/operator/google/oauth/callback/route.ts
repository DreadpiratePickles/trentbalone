import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized } from "@/lib/session";
import { isOperator } from "@/lib/google/operator-auth";
import { exchangeCodeForTokens } from "@/lib/google/google-oauth";
import { saveGoogleConnection } from "@/lib/google/google-connection";

// OAuth redirect target. Exchanges the auth code for a refresh token and stores
// the operator connection. The operator session gating is the CSRF protection.
export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  if (!isOperator(user.email)) return forbidden();

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  if (oauthError) return NextResponse.json({ error: `Google denied access: ${oauthError}` }, { status: 400 });
  if (!code) return NextResponse.json({ error: "Missing authorization code." }, { status: 400 });

  try {
    const credentials = await exchangeCodeForTokens(code);
    await saveGoogleConnection(credentials);
    return NextResponse.json({ connected: true, scopes: credentials.scopes });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect Google." },
      { status: 502 },
    );
  }
}
