/**
 * [D9] Every tool adapter's provenance, declared (council verdict 2026-09-26, P16).
 *
 * Before this table the untrusted list was a hand-kept array in `governance/provenance.ts`, and an
 * adapter nobody remembered to add defaulted to `trusted`: a new email or chat toolset would have
 * shipped with its inbox outside the quarantine and not one test failing. Now every adapter Trent
 * registers — the builder's, the fleet-memory hook's, and the read-only app's — has an entry, the
 * runtime list (`UNTRUSTED_ADAPTERS`) is DERIVED from it, and
 * `governance/provenance-registration.test.ts` builds every adapter and fails on:
 *   - an adapter with no entry (so a new adapter must be declared before it ships);
 *   - an adapter whose tool names say it reaches off this machine but is declared `local`;
 *   - an `off_machine` adapter declared plain `trusted`;
 *   - a declaration the runtime classifier disagrees with, tool by tool.
 *
 * Data only: this module imports nothing, so `governance/provenance.ts` can read it without a cycle
 * and the egress coverage scan has nothing to flag.
 */

/** Where an adapter's calls can reach. `off_machine`: any network, peer, provider or third-party code. */
export type AdapterReach = "local" | "off_machine";

/**
 * What an adapter's output is. `untrusted`: every call, always (the open web, a third-party server).
 * `trusted`: authored on this machine or by the operator. `per_call`: the adapter tags its own
 * record untrusted when that call returned somebody else's text, and `untrustedTools` names the
 * tools that are untrusted on every call.
 */
export type DeclaredProvenance = "untrusted" | "trusted" | "per_call";

export interface AdapterProvenanceDeclaration {
  readonly reach: AdapterReach;
  readonly provenance: DeclaredProvenance;
  /** `per_call` only: tools the classifier tags untrusted on every call, by name or scope. */
  readonly untrustedTools?: readonly string[];
  /**
   * [D11] The adapter returns workspace content, so once a network-derived command wrote into the
   * workspace (`tools/terminal/taint.ts`) every one of its calls there is untrusted.
   */
  readonly readsWorkspace?: boolean;
  /** Why, in one line: what a reviewer checks the declaration against. */
  readonly why: string;
}

export const ADAPTER_PROVENANCE = {
  // The builder's toolsets (`tools/index.ts` buildTrentTools).
  web: { reach: "off_machine", provenance: "untrusted", why: "search results and fetched pages are the open internet" },
  browser: { reach: "off_machine", provenance: "untrusted", why: "a rendered page is the open internet" },
  mcp: { reach: "off_machine", provenance: "untrusted", why: "a third-party server writes its tool descriptions and results" },
  plugins: { reach: "off_machine", provenance: "untrusted", why: "a third-party manifest and its code" },
  vision: { reach: "off_machine", provenance: "untrusted", why: "an image can carry typographic or embedded instructions (SEC-1 T-03)" },
  media: { reach: "off_machine", provenance: "untrusted", why: "a transcribed or described clip is text somebody else authored (SEC-1 T-03)" },
  a2a: { reach: "off_machine", provenance: "untrusted", why: "a peer agent's answer; recorded decision: adapter-level untrusted, every call inbound" },
  social: {
    reach: "off_machine",
    provenance: "per_call",
    untrustedTools: ["social_inbox_list"],
    why: "posts go out; the inbox is strangers' text and is tagged by name and by the adapter",
  },
  business: {
    reach: "off_machine",
    provenance: "per_call",
    why: "Stripe, Calendar, Square and Twilio; the two reads that return customer-authored text tag their own record",
  },
  terminal: {
    reach: "off_machine",
    provenance: "per_call",
    readsWorkspace: true,
    why: "[D11] a command on the egress seat is network-derived and tagged by the adapter; the isolated seat is trusted until the workspace is",
  },
  delegation: { reach: "off_machine", provenance: "per_call", why: "a child that read external content tags its own record, and the tag travels" },
  tools: { reach: "off_machine", provenance: "per_call", why: "the disclosure bridge re-enters the wrapped adapter it names, which tags the call" },
  file_ops: { reach: "local", provenance: "per_call", readsWorkspace: true, why: "[D11] workspace files, untrusted once a network command wrote into the workspace" },
  code_execution: { reach: "local", provenance: "per_call", readsWorkspace: true, why: "[D11] no network, but it reads the workspace" },
  cron: { reach: "local", provenance: "trusted", why: "this profile's own schedule" },
  skills: { reach: "local", provenance: "trusted", why: "this profile's skills; writing one is gated separately (skill_manage)" },
  human: { reach: "local", provenance: "trusted", why: "the founder's own answer" },
  todo: { reach: "local", provenance: "trusted", why: "the run's own task list" },
  clarify: { reach: "local", provenance: "trusted", why: "the founder's own answer" },
  session_search: { reach: "local", provenance: "trusted", why: "this profile's own transcripts" },
  // The fleet-memory hook's adapters (`apps/cli/src/repl/fleet-memory.ts`): the gated write target and its readers.
  memory: { reach: "local", provenance: "trusted", why: "the shared layer the gate protects; its writes are held, not its reads" },
  fleet_search: { reach: "local", provenance: "trusted", why: "the fleet's own memory and shared skills" },
  brain_read: { reach: "local", provenance: "trusted", why: "the fleet's own brain notes" },
  // The read-only app's adapters (`apps/web/lib/tools.ts`, `tool-names.ts` APP_ADAPTER_NAMES). They are
  // registered by the app rather than this builder; declared so one routed through the wrapper is quarantined.
  GitHub: { reach: "off_machine", provenance: "untrusted", why: "issues, pull requests and comments are strangers' text" },
  "Steel Browser": { reach: "off_machine", provenance: "untrusted", why: "a hosted browser is the open internet" },
  Camofox: { reach: "off_machine", provenance: "untrusted", why: "a browser is the open internet" },
} as const satisfies Readonly<Record<string, AdapterProvenanceDeclaration>>;

export type DeclaredAdapterName = keyof typeof ADAPTER_PROVENANCE;

/** The declaration for `name`, or undefined when nobody declared it. */
export function declaredProvenance(name: string): AdapterProvenanceDeclaration | undefined {
  return Object.prototype.hasOwnProperty.call(ADAPTER_PROVENANCE, name) ? ADAPTER_PROVENANCE[name as DeclaredAdapterName] : undefined;
}

/** The adapters declared untrusted on every call, lowercased: what `adapterProvenance` matches. */
export function declaredUntrustedAdapters(): string[] {
  return Object.entries(ADAPTER_PROVENANCE)
    .filter(([, declaration]) => declaration.provenance === "untrusted")
    .map(([name]) => name.toLowerCase());
}

/** Whether `name` returns workspace content (D11). */
export function readsWorkspace(name: string): boolean {
  return (declaredProvenance(name) as AdapterProvenanceDeclaration | undefined)?.readsWorkspace === true;
}

/**
 * Name tokens that mean a tool talks to something off this machine: a network, a provider, a
 * messaging surface, a third party's code. Matched on the `_`/space-separated tokens of the adapter
 * name and every tool name, so `email_send`, `slack_post` and `matrix_room_read` all match while
 * `session_search` and `search_files` do not. Deliberately generous: a false positive costs one
 * declaration line; a false negative is an unquarantined inbox.
 */
const OFF_MACHINE_TOKEN =
  /^(?:web|www|http|https|url|fetch|download|upload|browser|browse|crawl|scrape|mcp|plugins?|a2a|peer|remote|api|webhook|email|mail|gmail|inbox|inbound|imap|smtp|sms|mms|whatsapp|telegram|signal|slack|discord|matrix|teams|chat|dm|social|twitter|tweet|bluesky|mastodon|linkedin|reddit|youtube|post|publish|send|reply|stripe|square|twilio|calendar|github|gitlab|jira|notion|drive|dropbox|s3|vision|image|media|transcribe|video|audio)$/;

export function looksOffMachine(adapter: { readonly name: string; readonly scopes: readonly string[] }): boolean {
  const tokens = [adapter.name, ...adapter.scopes].flatMap((name) => name.toLowerCase().split(/[^a-z0-9]+/));
  return tokens.some((token) => OFF_MACHINE_TOKEN.test(token));
}

export interface ProvenanceRegistrationProblem {
  readonly adapter: string;
  readonly problem: string;
}

/** What is wrong with these adapters' declarations; empty when every one is declared and consistent. */
export function provenanceRegistrationProblems(
  adapters: ReadonlyArray<{ readonly name: string; readonly scopes: readonly string[] }>,
): ProvenanceRegistrationProblem[] {
  const problems: ProvenanceRegistrationProblem[] = [];
  for (const adapter of adapters) {
    const declaration = declaredProvenance(adapter.name);
    const offMachine = looksOffMachine(adapter);
    if (declaration === undefined) {
      problems.push({
        adapter: adapter.name,
        problem: offMachine
          ? `no provenance declaration, and its tools reach off this machine: declare it in tools/provenance-registry.ts (untrusted or per_call)`
          : `no provenance declaration: declare it in tools/provenance-registry.ts`,
      });
      continue;
    }
    if (offMachine && declaration.reach !== "off_machine") {
      problems.push({ adapter: adapter.name, problem: `declared local, but its tools reach off this machine` });
    }
    if (declaration.reach === "off_machine" && declaration.provenance === "trusted") {
      problems.push({ adapter: adapter.name, problem: `reaches off this machine and is declared trusted: declare it untrusted or per_call` });
    }
  }
  return problems;
}
