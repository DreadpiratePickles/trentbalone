/**
 * [C1] Promoting a memory draft also writes the company's semantic facts.
 *
 * The truth rule puts facts with a lifetime in `Document` rows, and the ONLY writer of those rows
 * is this path: a seat appends episodes, the C4 gate refuses a seat anything but `append` on a
 * block, and the consolidation's delta operations are the one place an entry is ever replaced,
 * removed or merged. The facts are written at PROMOTION and not at draft time, because a draft in
 * quarantine is a proposal and a proposal is not a fact.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryImproveStore } from "../improve/memory-store.js";
import type { GatewayCompletion } from "../model-gateway/types.js";
import { ENTRY_SEPARATOR, memoryPath } from "../tools/memory/store.js";
import type { AppDocument } from "./app-tiers.js";
import { semanticFactSource, type AppMemoryWriteModules, type AppSemanticFact } from "./app-writes.js";
import { consolidateMemory, promoteMemoryDraft } from "./consolidate.js";

const COMPANY = "co_consolidate_app";
const NOW = "2026-09-18T03:00:00.000Z";
const tmpDirs: string[] = [];

const MEMORY_BEFORE = ["Ship on Fridays only after the smoke suite is green.", "Ship on Fridays after smoke is green.", "Invoices go out on the 1st."].join(
  ENTRY_SEPARATOR,
);
const USER_BEFORE = ["Prefers short replies.", "Prefers brief replies.", "Timezone is Europe/London."].join(ENTRY_SEPARATOR);
const OPS_REPLY = JSON.stringify({ ops: { memory: [{ op: "remove", entry_id: "e2" }], user: [{ op: "replace", entry_id: "e2", text: "Prefers one-line replies." }] } });

function profile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-consolidate-app-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "memories"), { recursive: true });
  fs.writeFileSync(memoryPath(dir, "memory"), MEMORY_BEFORE, "utf8");
  fs.writeFileSync(memoryPath(dir, "user"), USER_BEFORE, "utf8");
  return dir;
}

function fakeGateway() {
  return {
    async complete(): Promise<GatewayCompletion> {
      return {
        text: OPS_REPLY,
        provider: "anthropic",
        model: "fake",
        modelTier: "sonnet",
        inputTokens: 10,
        outputTokens: 10,
        costCents: 3,
        estimated: false,
        priced_as_default: false,
        finishReason: "stop",
      };
    },
  };
}

function writeModules(documents: AppDocument[] = [], fail?: string): AppMemoryWriteModules & { facts: AppSemanticFact[]; expired: string[] } {
  const facts: AppSemanticFact[] = [];
  const expired: string[] = [];
  return {
    facts,
    expired,
    async writeEpisodicMemory() {
      throw new Error("consolidation writes facts, never episodes");
    },
    createSemanticMemory() {
      const staged: AppSemanticFact[] = [];
      return {
        add: (fact) => void staged.push(fact),
        flush: async () => {
          if (fail !== undefined) throw new Error(fail);
          facts.push(...staged);
          return staged.map((_, i) => ({ id: `doc_new_${i}` }));
        },
      };
    },
    async listDocuments() {
      return documents;
    },
    async expireDocument(id) {
      expired.push(id);
    },
  };
}

function factDoc(id: string, block: string, text: string): AppDocument {
  return {
    id,
    companyId: COMPANY,
    type: "agent_note",
    title: `[semantic] ${block}`,
    content: text,
    source: semanticFactSource(block, text),
    version: 1,
    memoryTier: "semantic",
    createdAt: "2026-09-17T00:00:00.000Z",
  };
}

async function draftAndPromote(modules: AppMemoryWriteModules, failures: string[] = []) {
  const dir = profile();
  const store = new InMemoryImproveStore();
  const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway() as never, store, now: NOW });
  if (result.status !== "drafted") throw new Error(result.status);
  const promoted = await promoteMemoryDraft({
    store,
    draftId: result.draft.id,
    actor: "human",
    now: NOW,
    appMemory: { modules, onFailure: (message) => void failures.push(message) },
  });
  return { dir, promoted };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("promoting a memory draft writes the company's semantic facts", () => {
  it("writes a replaced entry as a new fact and expires the row a removed entry wrote", async () => {
    const modules = writeModules([
      factDoc("doc_friday", "memory", "Ship on Fridays after smoke is green."),
      factDoc("doc_brief", "user", "Prefers brief replies."),
    ]);
    const { promoted } = await draftAndPromote(modules);

    expect(promoted.status).toBe("live");
    // The `replace` on USER.md becomes a fact that supersedes the row the old entry wrote.
    expect(modules.facts.map((fact) => fact.content)).toEqual(["Prefers one-line replies."]);
    expect(modules.facts[0]?.factType).toBe("user");
    expect(modules.facts[0]?.supersedesId).toBe("doc_brief");
    // The `remove` on MEMORY.md writes nothing and expires the row instead.
    expect(modules.expired).toEqual(["doc_friday"]);
  });

  it("still writes the files, and says why, when the app store cannot take the facts", async () => {
    const failures: string[] = [];
    const { dir, promoted } = await draftAndPromote(writeModules([], "the URL must start with the protocol `postgresql://`"), failures);

    expect(promoted.status).toBe("live");
    expect(fs.readFileSync(memoryPath(dir, "memory"), "utf8")).not.toContain("Ship on Fridays after smoke is green.");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("postgresql");
  });

  it("loads no app writer, writes the files and reports no failure when the app store is not usable", async () => {
    // The default path (no injected modules) consults the one predicate before `loadAppWriteModules`
    // would import anything: on a profile without a postgres DATABASE_URL the promotion is complete
    // once the files are written, and the doctor — not a failure line per promotion — says why the
    // company's semantic tier is not in use.
    const loaded: string[] = [];
    for (const specifier of ["@/lib/store", "@/lib/memory-tiers"]) {
      vi.doMock(specifier, () => {
        loaded.push(specifier);
        return { store: {}, writeEpisodicMemory: async () => undefined, SemanticMemory: class {} };
      });
    }
    vi.stubEnv("DATABASE_URL", "file:/tmp/profile/trent.db");
    try {
      const failures: string[] = [];
      const dir = profile();
      const store = new InMemoryImproveStore();
      const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway() as never, store, now: NOW });
      if (result.status !== "drafted") throw new Error(result.status);
      const promoted = await promoteMemoryDraft({
        store,
        draftId: result.draft.id,
        actor: "human",
        now: NOW,
        appMemory: { onFailure: (message) => void failures.push(message) },
      });
      expect(promoted.status).toBe("live");
      expect(fs.readFileSync(memoryPath(dir, "user"), "utf8")).toContain("Prefers one-line replies.");
      expect(failures).toEqual([]);
      expect(loaded).toEqual([]);
    } finally {
      for (const specifier of ["@/lib/store", "@/lib/memory-tiers"]) vi.doUnmock(specifier);
      vi.unstubAllEnvs();
    }
  });

  it("writes no fact at all when the caller asks for none", async () => {
    const dir = profile();
    const store = new InMemoryImproveStore();
    const result = await consolidateMemory({ profileDir: dir, companyId: COMPANY, gateway: fakeGateway() as never, store, now: NOW });
    if (result.status !== "drafted") throw new Error(result.status);
    const promoted = await promoteMemoryDraft({ store, draftId: result.draft.id, actor: "human", now: NOW, appMemory: false });
    expect(promoted.status).toBe("live");
    expect(fs.readFileSync(memoryPath(dir, "user"), "utf8")).toContain("Prefers one-line replies.");
  });
});
