import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized } from "@/lib/session";
import { isOperator } from "@/lib/google/operator-auth";
import { buildGoogleConsentUrl } from "@/lib/google/google-oauth";
import { makeId } from "@/lib/utils";

// Returns the Google consent URL for the operator to grant Gmail/Calendar
// access. The client navigates to it. Inert until the OAuth app is configured.
export async function GET() {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  if (!isOperator(user.email)) return forbidden();

  try {
    const state = makeId("gstate");
    const authUrl = buildGoogleConsentUrl({ state });
    return NextResponse.json({ authUrl, state });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Google OAuth is not configured." },
      { status: 503 },
    );
  }
}
