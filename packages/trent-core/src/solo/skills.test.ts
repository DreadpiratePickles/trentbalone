/**
 * [S3] Skills on demand in solo (item 3; council A7).
 *
 * The frozen prefix lists each installed skill's name and one line, never a body. `skill_view` loads
 * a body into the CONTEXT tier for the rest of the conversation: the name joins a per-conversation
 * "invoked skills" set, saved with the session, and every later turn's opening carries the bodies,
 * read from the store at that turn. So a body survives a compaction that dropped the `skill_view`
 * result, and a restart. A view of a skill's bundled file is not an invocation.
 * Real skills adapter over a temp profile; scripted gateway.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillsAdapter } from "../tools/skills/index.js";
import type { GatewayStreamRequest } from "../model-gateway/types.js";
import { FIXED_NOW, collect, fakeMeter, memoryState, scriptedGateway, sequentialIds, toolCall } from "./fakes.test-helpers.js";
import { SUMMARY_REPLY, filler, routedGateway, systemIn, tempProfile } from "./fakes-s3.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession } from "./session-store.js";
import { invokedSkillOf, profileSoloSkills } from "./skills.js";
import type { SoloGateway, SoloSession, SoloStateStore } from "./types.js";

type RecordingGateway = SoloGateway & { readonly requests: GatewayStreamRequest[] };

let profileDir = "";
beforeEach(async () => {
  profileDir = tempProfile("trent-solo-s3-skills-");
  const adapter = createSkillsAdapter({ profileDir });
  const created = await adapter.execute(
    `skill_manage ${JSON.stringify({
      operations: [
        { action: "create", name: "release-notes", category: "engineering", description: "Draft release notes from merged PRs", content: "# Release notes\nBODY-MARKER-RN: collect merged PRs, group by area, one line each." },
        { action: "create", name: "cold-email", category: "sales", description: "Write a first cold email", content: "# Cold email\nBODY-MARKER-CE: three sentences, one ask." },
      ],
    })}`,
    {},
  );
  expect(created.status, created.summary).toBe("completed");
});
afterEach(() => fs.rmSync(profileDir, { recursive: true, force: true }));

const VIEW = 'skill_view {"name": "release-notes"}';
const VIEW_FILE = 'skill_view {"name": "release-notes", "file_path": "references/style.md"}';

function runnerWith(script: string[], options: { session?: SoloSession; state?: SoloStateStore; gateway?: RecordingGateway } = {}) {
  const gateway: RecordingGateway = options.gateway ?? scriptedGateway(script);
  const skills = createSkillsAdapter({ profileDir });
  const runner = createSoloRunner({
    gateway,
    tools: { adapters: [skills] },
    session: options.session ?? memorySoloSession(),
    memory: async () => ({ stable: [], context: [] }),
    meter: fakeMeter(),
    now: FIXED_NOW,
    newId: sequentialIds(),
    skills: profileSoloSkills(path.join(profileDir, "skills")),
    compaction: { compactAfterChars: 1_500, historyChars: 400, auto: false },
    ...(options.state === undefined ? {} : { state: options.state, sessionId: "sess_skills" }),
  });
  return { runner, gateway };
}

const openingOf = (gateway: RecordingGateway, n: number): string => gateway.requests[n]?.messages.at(-1)?.content ?? "";

describe("[S3] the prompt lists skills by name and one line, never a body", () => {
  it("puts an index of every skill in the frozen prefix and no body anywhere until one is viewed", async () => {
    const { runner, gateway } = runnerWith(["Hello."]);
    await collect(runner.run({ objective: "Hi" }));
    const system = systemIn(gateway.requests[0]);
    expect(system).toContain("release-notes: Draft release notes from merged PRs");
    expect(system).toContain("cold-email: Write a first cold email");
    expect(system).toContain('{"name": "skill_view", "arguments": {"name": "<skill>"}}');
    expect(JSON.stringify(gateway.requests[0]?.messages)).not.toContain("BODY-MARKER");
  });
});

describe("[S3] skill_view loads a body into the context tier for the rest of the conversation", () => {
  it("carries the viewed body in every later turn's opening, and only the viewed one", async () => {
    const { runner, gateway } = runnerWith([toolCall(VIEW), "Loaded.", "Drafting now.", "Done."]);
    await collect(runner.run({ objective: "Use the release notes skill" }));
    await collect(runner.run({ objective: "Draft this week's notes" }));
    await collect(runner.run({ objective: "Anything else?" }));

    for (const n of [2, 3]) {
      expect(openingOf(gateway, n)).toContain("BODY-MARKER-RN");
      expect(openingOf(gateway, n)).not.toContain("BODY-MARKER-CE");
    }
    // The prefix is untouched by it: still the index only.
    expect(systemIn(gateway.requests[3])).toBe(systemIn(gateway.requests[0]));
  });

  it("survives a compaction that dropped the skill_view result", async () => {
    const answers = Array.from({ length: 3 }, (_, i) => filler(`ANSWER-${String(i)}`, 600));
    const gateway = routedGateway([toolCall(VIEW), "Loaded.", ...answers, "After compaction."], { summary: [SUMMARY_REPLY] });
    const session = memorySoloSession();
    const { runner } = runnerWith([], { gateway, session });
    await collect(runner.run({ objective: "Use the release notes skill" }));
    for (const i of [0, 1, 2]) await collect(runner.run({ objective: filler(`QUESTION-${String(i)}`, 600) }));

    expect(await runner.compact?.({ force: true })).toMatchObject({ status: "compacted" });
    expect(JSON.stringify(await session.history())).not.toContain("BODY-MARKER-RN");
    await collect(runner.run({ objective: "Draft the notes" }));
    expect(gateway.requests.at(-1)?.messages.at(-1)?.content).toContain("BODY-MARKER-RN");
  });

  it("survives a restart: the invoked set is saved with the session", async () => {
    const session = memorySoloSession();
    const state = memoryState();
    await collect(runnerWith([toolCall(VIEW), "Loaded."], { session, state }).runner.run({ objective: "Use the release notes skill" }));
    expect(state.saved?.invokedSkills).toEqual(["release-notes"]);

    const restarted = runnerWith(["Drafting."], { session, state });
    await collect(restarted.runner.run({ objective: "Draft the notes" }));
    expect(openingOf(restarted.gateway, 0)).toContain("BODY-MARKER-RN");
  });
});

describe("[S3] what counts as loading a skill", () => {
  it("a completed skill_view of the skill itself, never of a bundled file, a failed view or another tool", () => {
    expect(invokedSkillOf({ adapter: "skills", action: VIEW, status: "completed", summary: "# release-notes" })).toBe("release-notes");
    expect(invokedSkillOf({ adapter: "skills", action: VIEW_FILE, status: "completed", summary: "## file" })).toBeUndefined();
    expect(invokedSkillOf({ adapter: "skills", action: VIEW, status: "failed", summary: "not found" })).toBeUndefined();
    expect(invokedSkillOf({ adapter: "skills", action: 'skills_list {}', status: "completed", summary: "2 skills" })).toBeUndefined();
    expect(invokedSkillOf({ adapter: "file_ops", action: 'skill_view {"name": "x"}', status: "completed", summary: "" })).toBeUndefined();
  });
});
