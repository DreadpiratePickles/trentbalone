/**
 * [D9] The provenance registration guard (council verdict 2026-09-26, P16).
 *
 * The provenance gate is only as good as the list that says which adapters return text somebody
 * outside this machine wrote. Before D9 that list was a hand-kept array in `provenance.ts`, and an
 * adapter nobody added to it defaulted to `trusted` — a new email or messaging toolset would have
 * shipped unquarantined without one failing test. `tools/provenance-registry.ts` now declares every
 * adapter explicitly (where it reaches, and what its output is), `UNTRUSTED_ADAPTERS` is derived
 * from it, and this suite builds every adapter the builder can register and holds the declarations
 * to them in both directions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTrentTools, IMPLEMENTED_TOOLSETS, TOOLSET_BY_ADAPTER } from "../tools/index.js";
import { APP_ADAPTER_NAMES, BUILTIN_TOOLS_BY_TOOLSET } from "../tools/tool-names.js";
import { adapterProvenance, UNTRUSTED_ADAPTERS } from "./provenance.js";

type Registry = typeof import("../tools/provenance-registry.js");
const registry: Registry | undefined = await import("../tools/provenance-registry.js").catch(() => undefined);
const need = (): Registry => {
  expect(registry, "tools/provenance-registry.ts must declare every adapter's provenance").toBeDefined();
  return registry!;
};

interface BuiltAdapter {
  readonly name: string;
  readonly scopes: readonly string[];
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-provenance-registration-"));
let built: BuiltAdapter[] = [];

/** Every tool name an adapter answers to: its advertised scopes plus the reserved family table. */
function toolsOf(adapter: BuiltAdapter): string[] {
  const reserved = BUILTIN_TOOLS_BY_TOOLSET[adapter.name] ?? [];
  return [...new Set([...adapter.scopes, ...reserved])].filter((tool) => !tool.includes(":"));
}

beforeAll(async () => {
  const caCertPath = path.join(root, "ca.pem");
  fs.writeFileSync(caCertPath, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
  const build = buildTrentTools(
    { toolsets: [...IMPLEMENTED_TOOLSETS], disabled_toolsets: [] },
    { workspace: root, profileDir: path.join(root, "profile"), backend: "local", egress: { proxyUrl: "http://127.0.0.1:1", token: "tok", caCertPath } },
  );
  expect(build.skipped).toEqual([]);
  built = build.adapters.map((adapter) => ({ name: adapter.name, scopes: [...adapter.scopes] }));
  await Promise.all(build.adapters.map((adapter) => adapter.cleanup()));
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("[D9] every registered adapter declares its provenance", () => {
  it("a full build registers no adapter without an explicit declaration", () => {
    const { ADAPTER_PROVENANCE, provenanceRegistrationProblems } = need();
    expect(built.length).toBeGreaterThanOrEqual(20);
    for (const adapter of built) expect(Object.keys(ADAPTER_PROVENANCE), `${adapter.name} has no provenance declaration`).toContain(adapter.name);
    expect(provenanceRegistrationProblems(built)).toEqual([]);
  });

  it("covers the adapters registered outside this builder too, and declares nothing that does not exist", () => {
    const { ADAPTER_PROVENANCE } = need();
    const outside = [...Object.keys(TOOLSET_BY_ADAPTER), "brain_read", ...APP_ADAPTER_NAMES];
    for (const name of outside) expect(Object.keys(ADAPTER_PROVENANCE), `${name} has no provenance declaration`).toContain(name);
    const known = new Set([...built.map((adapter) => adapter.name), ...outside]);
    for (const name of Object.keys(ADAPTER_PROVENANCE)) expect(known.has(name), `${name} is declared but nothing registers it`).toBe(true);
  });

  it("an adapter whose tools reach off this machine is declared off_machine, and never plain trusted", () => {
    const { ADAPTER_PROVENANCE, looksOffMachine } = need();
    for (const adapter of built) {
      const declaration = ADAPTER_PROVENANCE[adapter.name as keyof typeof ADAPTER_PROVENANCE];
      if (looksOffMachine({ name: adapter.name, scopes: toolsOf(adapter) })) expect(declaration.reach, adapter.name).toBe("off_machine");
      if (declaration.reach === "off_machine") expect(declaration.provenance, adapter.name).not.toBe("trusted");
    }
    // The families the council named are all among the off-machine declarations.
    for (const name of ["web", "browser", "mcp", "plugins", "vision", "media", "a2a", "social", "business", "terminal"]) {
      expect(ADAPTER_PROVENANCE[name as keyof typeof ADAPTER_PROVENANCE].reach, name).toBe("off_machine");
    }
    // And the ones that are always somebody else's text stay untrusted on every call: downgrading
    // one to per_call would hand its quarantine to the adapter's own tagging.
    for (const name of ["web", "browser", "mcp", "plugins", "vision", "media", "a2a"]) {
      expect(ADAPTER_PROVENANCE[name as keyof typeof ADAPTER_PROVENANCE].provenance, name).toBe("untrusted");
    }
  });

  it("the runtime classifier agrees with every declaration, tool by tool", () => {
    const { ADAPTER_PROVENANCE } = need();
    for (const adapter of built) {
      const declaration = ADAPTER_PROVENANCE[adapter.name as keyof typeof ADAPTER_PROVENANCE] as { provenance: string; untrustedTools?: readonly string[] };
      for (const tool of toolsOf(adapter)) {
        const expected =
          declaration.provenance === "untrusted" || (declaration.untrustedTools ?? []).includes(tool) ? "untrusted" : "trusted";
        expect(adapterProvenance(adapter.name, tool, adapter.scopes), `${adapter.name} ${tool}`).toBe(expected);
      }
    }
  });

  it("UNTRUSTED_ADAPTERS is derived from the declarations, plus the inbound class", () => {
    const { ADAPTER_PROVENANCE } = need();
    const declared = Object.entries(ADAPTER_PROVENANCE)
      .filter(([, declaration]) => declaration.provenance === "untrusted")
      .map(([name]) => name.toLowerCase());
    expect([...UNTRUSTED_ADAPTERS].sort()).toEqual([...declared, "inbound"].sort());
  });

  it("a new off-machine adapter nobody declared fails the guard, whatever it is called", () => {
    const { provenanceRegistrationProblems } = need();
    const email = { name: "email", scopes: ["email", "email_inbox_read", "email_send"] };
    const matrix = { name: "chat", scopes: ["chat", "matrix_room_read", "slack_post"] };
    const local = { name: "notes", scopes: ["notes", "notes_list"] };
    const problems = provenanceRegistrationProblems([email, matrix, local]);
    expect(problems.map((problem) => problem.adapter).sort()).toEqual(["chat", "email", "notes"]);
    expect(problems.find((problem) => problem.adapter === "email")!.problem).toMatch(/off this machine/);
    expect(problems.find((problem) => problem.adapter === "notes")!.problem).toMatch(/no provenance declaration/);
  });
});
