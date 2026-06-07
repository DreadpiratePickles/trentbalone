import { describe, it, expect, beforeEach } from "vitest";
import {
  publishDegradedTools,
  getDegradedTools,
  clearToolHealthCacheForTests,
} from "@/lib/tool-health-cache";

describe("tool-health-cache", () => {
  beforeEach(() => clearToolHealthCacheForTests());

  it("returns an empty set on a miss", () => {
    expect(getDegradedTools("c1").size).toBe(0);
  });

  it("round-trips a published degraded set", () => {
    publishDegradedTools("c1", ["github_api", "sql_query"], 1000);
    const tools = getDegradedTools("c1", 1000);
    expect([...tools].sort()).toEqual(["github_api", "sql_query"]);
  });

  it("isolates companies", () => {
    publishDegradedTools("c1", ["github_api"], 1000);
    expect(getDegradedTools("c2", 1000).size).toBe(0);
  });

  it("publishing an empty set clears the entry", () => {
    publishDegradedTools("c1", ["github_api"], 1000);
    publishDegradedTools("c1", [], 1000);
    expect(getDegradedTools("c1", 1000).size).toBe(0);
  });

  it("expires stale entries past the TTL", () => {
    publishDegradedTools("c1", ["github_api"], 1000);
    // 1h + 1ms later → stale
    expect(getDegradedTools("c1", 1000 + 60 * 60 * 1000 + 1).size).toBe(0);
    // and the stale entry is evicted
    expect(getDegradedTools("c1", 1000).size).toBe(0);
  });

  it("returns a copy so callers cannot mutate the cache", () => {
    publishDegradedTools("c1", ["github_api"], 1000);
    getDegradedTools("c1", 1000).add("spoofed");
    expect([...getDegradedTools("c1", 1000)]).toEqual(["github_api"]);
  });
});
