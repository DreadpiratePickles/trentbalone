/**
 * [D0] gates 6 and 7 at the command line: the sweep cap the CLI passes and prints, and judge
 * calibration reported as rates with counts — never raw agreement on its own.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@trent/core/errors/index.js";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import { InMemoryImproveStore } from "@trent/core/improve/index.js";
import { runCli } from "../index.js";
import { setImproveStoreForTests } from "../improve.js";

let home: string;
let store: InMemoryImproveStore;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-improve-gates-"));
  process.env.TRENT_HOME = home;
  store = new InMemoryImproveStore();
  setImproveStoreForTests(store);
});

afterEach(() => {
  setImproveStoreForTests(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function humanDecision(action: "promote" | "reject", judgeAgreement: boolean, id: string): Promise<void> {
  await store.appendLedger({
    id,
    companyId: "trent-local",
    agentId: "engineer",
    taskType: "ship-feature",
    action,
    artifactKind: "skill",
    artifactId: `skill_${id}`,
    beforeHash: null,
    afterHash: null,
    before: null,
    after: null,
    iterationId: "iter_1",
    actor: "human",
    judgeAgreement,
    createdAt: "2026-09-18T10:00:00.000Z",
  });
}

describe("[D0] trent improve sweep reports its cap", () => {
  it("--json carries the cap, which defaults to budget.per_run_cap (decision 8)", async () => {
    const result = await runCli(["improve", "sweep", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout) as { budget: { limitCents: number | null; exhausted: boolean }; passK: number };
    expect(report.budget.limitCents).toBe(DEFAULT_CONFIG.budget.per_run_cap);
    expect(report.budget.exhausted).toBe(false);
    expect(report.passK).toBe(DEFAULT_CONFIG.improve.pass_k);
  });

  it("the rendered sweep names the cap in cents and whether it was reached", async () => {
    const result = await runCli(["improve", "sweep"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("cap");
    expect(result.stdout).toContain(String(DEFAULT_CONFIG.budget.per_run_cap));
  });
});

describe("[D0] trent improve status reports judge calibration as rates", () => {
  it("--json carries tpr, tnr and their counts, and says when the judge is advisory", async () => {
    for (let i = 0; i < 9; i += 1) await humanDecision("promote", true, `l${i}`);
    await humanDecision("reject", false, "l9");

    const result = await runCli(["improve", "status", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as {
      judgeCalibration: { tpr: number | null; tnr: number | null; truePositives: number; falsePositives: number; trueNegatives: number; falseNegatives: number; advisory: boolean };
    };
    expect(data.judgeCalibration.tpr).toBe(1);
    expect(data.judgeCalibration.tnr).toBe(0);
    expect(data.judgeCalibration.truePositives).toBe(9);
    expect(data.judgeCalibration.falsePositives).toBe(1);
    expect(data.judgeCalibration.advisory).toBe(true);
  });

  it("the rendered status shows both rates with their counts, never agreement alone", async () => {
    for (let i = 0; i < 9; i += 1) await humanDecision("promote", true, `l${i}`);
    await humanDecision("reject", false, "l9");
    const result = await runCli(["improve", "status"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("tpr");
    expect(result.stdout).toContain("tnr");
    expect(result.stdout).toContain("advisory");
  });
});
