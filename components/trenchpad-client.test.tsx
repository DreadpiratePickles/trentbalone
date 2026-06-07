import { describe, expect, it } from "vitest";
import { TRENCHPAD_CLIENT_CAPABILITIES } from "@/components/trenchpad-client";

describe("Trenchpad client contract", () => {
  it("declares the Devin-class shell surfaces and reuses CeoCommandClient", () => {
    expect(TRENCHPAD_CLIENT_CAPABILITIES.layout).toEqual(["session_rail", "work_stream", "right_panel"]);
    expect(TRENCHPAD_CLIENT_CAPABILITIES.chatReuse).toBe("CeoCommandClient");
    expect(TRENCHPAD_CLIENT_CAPABILITIES.controls).toEqual(expect.arrayContaining(["inline_rename", "session_filters", "editable_planner", "playbooks", "secrets_env_panel", "wiki_search_handoff"]));
    expect(TRENCHPAD_CLIENT_CAPABILITIES.live).toEqual(expect.arrayContaining(["sse_eventsource", "terminal", "file_tree", "code_diff", "plan_status", "sandbox_preview", "inline_approval", "polling_fallback"]));
  });
});
