import { NextRequest, NextResponse } from "next/server";
import { runHeartbeatSweep } from "@/lib/heartbeat";

/**
 * Cron-triggered heartbeat sweep. Designed to be called by a scheduler
 * (Vercel Cron, BullMQ, or external cron) every 1–6 hours.
 *
 * Auth: pass `Authorization: Bearer ${CRON_SECRET}` if set.
 */
export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (!auth || !auth.startsWith("Bearer ") || auth.slice(7).trim() !== cronSecret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const reports = await runHeartbeatSweep();
  return NextResponse.json({ reports, count: reports.length });
}

export async function GET(request: NextRequest) {
  return POST(request);
}
