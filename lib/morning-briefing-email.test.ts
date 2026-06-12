import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleMorningBriefing } from "@/lib/scheduler";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

const ENV_KEYS = [
  "RESEND_API_KEY",
  "RESEND_AUTH_TOKEN",
  "RESEND_FROM_EMAIL",
  "RESEND_FROM_DOMAIN",
  "TRENT_FOUNDER_EMAIL",
  "FOUNDER_EMAIL",
  "MORNING_DIGEST_RECIPIENT",
  "TRENT_PLATFORM_DOMAIN",
  "BASE_DOMAIN",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("morning briefing email delivery", () => {
  it("sends a configured platform founder digest through Resend and records audit evidence", async () => {
    process.env.RESEND_API_KEY = "re_test_secret";
    process.env.RESEND_FROM_EMAIL = "Trent <admin@let-trent.uk>";
    process.env.TRENT_FOUNDER_EMAIL = "admin@let-trent.uk";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const company = await store.createCompany({
      name: `Briefing Email ${makeId("test")}`,
      brief: { vision: "Send real founder digests" },
    });
    await store.createTask({
      companyId: company.id,
      title: "Complete overnight evidence sweep",
      prompt: "Summarize overnight evidence",
      status: "completed",
      priority: "high",
      agentRole: "ceo",
      tags: ["nightly"],
    });

    const report = await assembleMorningBriefing(company.id);

    expect(report.type).toBe("morning_briefing");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer re_test_secret",
        "Content-Type": "application/json",
      }),
    }));
    const [, requestInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      from: "Trent <admin@let-trent.uk>",
      to: ["admin@let-trent.uk"],
      subject: report.title,
    });
    expect(body.text).toContain("Complete overnight evidence sweep");
    const audits = await store.listAuditLogs(company.id);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "morning_briefing.email_sent",
        objectId: report.id,
        summary: expect.stringContaining("Resend accepted email email_123"),
      }),
    ]));
  });

  it("skips delivery honestly when the email provider or founder recipient is not configured", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const company = await store.createCompany({
      name: `Briefing Email Skip ${makeId("test")}`,
      brief: { vision: "Do not fake email sends" },
    });

    const report = await assembleMorningBriefing(company.id);

    expect(fetchImpl).not.toHaveBeenCalled();
    const audits = await store.listAuditLogs(company.id);
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "morning_briefing.email_skipped",
        objectId: report.id,
        summary: expect.stringContaining("not configured"),
      }),
    ]));
    expect(audits).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "morning_briefing.email_sent" }),
    ]));
  });
});
