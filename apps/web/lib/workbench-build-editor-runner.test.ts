import { describe, expect, it } from "vitest";
import { createWorkbenchEditFile } from "@/lib/workbench-build-editor-runner";
import type { ArtifactStreamToken } from "@/lib/workbench-agent-types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { WorkbenchSession } from "@/lib/types";
import type { BuildPlan } from "@/lib/workbench-build-planner";

const session = {
  id: "sess_1",
  companyId: "co_1",
  objective: "build notes",
  agentRole: "engineer",
  agentMode: "build",
  provider: "mock_local",
  status: "running",
} as unknown as WorkbenchSession;

const plan: BuildPlan = {
  title: "Notes",
  decisions: "Note { id, body }",
  files: [{ path: "src/foo.ts", intent: "export a foo", dependsOn: [] }],
};

function fakeDeps(artifactText: string) {
  return {
    streamArtifact: (): AsyncGenerator<ArtifactStreamToken> => {
      async function* gen(): AsyncGenerator<ArtifactStreamToken> {
        yield { type: "token", content: artifactText };
        yield { type: "finish", reason: "stop" };
      }
      return gen();
    },
  };
}

function fakeProvider(writes: Record<string, string>): WorkbenchProviderAdapter {
  return {
    readFile: async () => {
      throw new Error("new file");
    },
    writeFile: async (_s: WorkbenchSession, path: string, content: string) => {
      writes[path] = content;
    },
  } as unknown as WorkbenchProviderAdapter;
}

function artifact(filePath: string, content: string): string {
  return `Here is the plan.\n<boltArtifact id="a" title="t">\n<boltAction type="file" filePath="${filePath}">${content}</boltAction>\n</boltArtifact>`;
}

describe("createWorkbenchEditFile", () => {
  it("writes a syntactically valid file and reports bytes", async () => {
    const writes: Record<string, string> = {};
    const editFile = createWorkbenchEditFile({
      session,
      deps: fakeDeps(artifact("src/foo.ts", "export const foo = 42;\n")),
      provider: fakeProvider(writes),
      systemPrompt: "sys",
      plan,
    });

    const result = await editFile(plan.files[0]);
    expect(result.ok).toBe(true);
    expect(writes["src/foo.ts"]).toContain("export const foo = 42;");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("rejects a syntactically broken file without writing it", async () => {
    const writes: Record<string, string> = {};
    const editFile = createWorkbenchEditFile({
      session,
      deps: fakeDeps(artifact("src/foo.ts", "export const = ;")),
      provider: fakeProvider(writes),
      systemPrompt: "sys",
      plan,
    });

    const result = await editFile(plan.files[0]);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/syntax error/i);
    expect(writes["src/foo.ts"]).toBeUndefined();
  });

  it("fails cleanly when the editor returns no file action", async () => {
    const writes: Record<string, string> = {};
    const editFile = createWorkbenchEditFile({
      session,
      deps: fakeDeps("I think we should consider the architecture first."),
      provider: fakeProvider(writes),
      systemPrompt: "sys",
      plan,
    });

    const result = await editFile(plan.files[0]);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no <boltAction/i);
  });
});
