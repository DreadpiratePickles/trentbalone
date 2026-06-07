import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized } from "@/lib/session";
import { isOperator } from "@/lib/google/operator-auth";
import { getGoogleConnectionStatus, revokeGoogleConnection } from "@/lib/google/google-connection";

// Operator-level Google connection: not scoped to a company. Reads feed GBrain
// memory; sends route through approval gates. Only the operator may view or
// revoke this connection.

export async function GET() {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  if (!isOperator(user.email)) return forbidden();

  const connection = await getGoogleConnectionStatus();
  return NextResponse.json({ connection });
}

export async function DELETE() {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  if (!isOperator(user.email)) return forbidden();

  const revoked = await revokeGoogleConnection();
  return NextResponse.json({ revoked });
}
