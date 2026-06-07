import { NextResponse } from "next/server";
import { buildApiOnlyTierDescriptor, listOpenAiCompatibleModels } from "@/lib/ai-proxy/access-tier";

export async function GET() {
  return NextResponse.json({
    ...listOpenAiCompatibleModels(),
    trent: buildApiOnlyTierDescriptor(),
  });
}
