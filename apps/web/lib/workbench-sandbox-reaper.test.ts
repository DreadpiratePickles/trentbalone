import { describe, expect, it, vi } from "vitest";
import {
  MANAGED_BY_TAG,
  reapIdleSandboxes,
  sandboxReaperEnabled,
  selectSandboxesToReap,
  type ReaperSandbox,
  type ReaperSession,
} from "./workbench-sandbox-reaper";

const NOW = Date.UTC(2026, 5, 24, 12, 0, 0);
const managed = (id: string, ageMin: number, extra: Partial<ReaperSandbox> = {}): ReaperSandbox => ({
  sandboxId: id,
  startedAt: new Date(NOW - ageMin * 60_000),
  metadata: { managedBy: MANAGED_BY_TAG },
  ...extra,
});

describe("selectSandboxesToReap", () => {
  const maxAgeMs = 60 * 60 * 1000; // 1h

  it("never touches sandboxes Trent didn't create", () => {
    const live = [{ sandboxId: "foreign", startedAt: new Date(0), metadata: { managedBy: "someone-else" } }];
    const out = selectSandboxesToReap({ live, sessions: new Map(), now: NOW, maxAgeMs });
    expect(out).toEqual([]);
  });

  it("reaps an orphan with no workbench session", () => {
    const out = selectSandboxesToReap({ live: [managed("orphan", 5)], sessions: new Map(), now: NOW, maxAgeMs });
    expect(out).toEqual([{ sandboxId: "orphan", reason: "orphan: no workbench session" }]);
  });

  it("reaps a sandbox whose session is terminal", () => {
    const sessions = new Map<string, ReaperSession>([["done", { status: "completed" }]]);
    const out = selectSandboxesToReap({ live: [managed("done", 2)], sessions, now: NOW, maxAgeMs });
    expect(out[0]).toMatchObject({ sandboxId: "done", reason: "session completed" });
  });

  it("keeps an active session within the age ceiling", () => {
    const sessions = new Map<string, ReaperSession>([["live", { status: "running" }]]);
    const out = selectSandboxesToReap({ live: [managed("live", 10)], sessions, now: NOW, maxAgeMs });
    expect(out).toEqual([]);
  });

  it("reaps even an active session once it exceeds the hard max age", () => {
    const sessions = new Map<string, ReaperSession>([["stuck", { status: "running" }]]);
    const out = selectSandboxesToReap({ live: [managed("stuck", 120)], sessions, now: NOW, maxAgeMs });
    expect(out[0].sandboxId).toBe("stuck");
    expect(out[0].reason).toContain("max age");
  });
});

describe("reapIdleSandboxes", () => {
  it("kills the selected sandboxes and reports counts, ignoring foreign ones", async () => {
    const live: ReaperSandbox[] = [
      managed("orphan", 1),
      managed("done", 1),
      managed("live", 1),
      { sandboxId: "foreign", metadata: { managedBy: "other" } },
    ];
    const killSandbox = vi.fn(async (_sandboxId: string) => {});
    const loadSessions = vi.fn(async (_sandboxes: ReaperSandbox[]) => new Map<string, ReaperSession>([
      ["done", { status: "failed" }],
      ["live", { status: "running" }],
    ]));

    const result = await reapIdleSandboxes({
      deps: { listSandboxes: async () => live, loadSessions, killSandbox },
      now: NOW,
      maxAgeMs: 60 * 60 * 1000,
    });

    expect(result).toEqual({ scanned: 4, managed: 3, reaped: 2, failures: 0 });
    expect(killSandbox.mock.calls.map((c) => c[0]).sort()).toEqual(["done", "orphan"]);
    // only the 3 managed sandboxes are handed to the session loader (foreign excluded)
    expect(loadSessions.mock.calls[0][0].map((s) => s.sandboxId)).toEqual(["orphan", "done", "live"]);
  });

  it("counts kill failures without throwing", async () => {
    const result = await reapIdleSandboxes({
      deps: {
        listSandboxes: async () => [managed("orphan", 1)],
        loadSessions: async () => new Map(),
        killSandbox: async () => { throw new Error("api down"); },
      },
      now: NOW,
    });
    expect(result).toMatchObject({ reaped: 0, failures: 1 });
  });
});

describe("sandboxReaperEnabled", () => {
  it("is on only when E2B is the provider and a key is present", () => {
    expect(sandboxReaperEnabled({ WORKBENCH_DEFAULT_PROVIDER: "e2b", E2B_API_KEY: "k" })).toBe(true);
    expect(sandboxReaperEnabled({ WORKBENCH_DEFAULT_PROVIDER: "railway", E2B_API_KEY: "k" })).toBe(false);
    expect(sandboxReaperEnabled({ WORKBENCH_DEFAULT_PROVIDER: "e2b" })).toBe(false);
  });
});
