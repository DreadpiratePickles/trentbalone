/**
 * Trace-level policy rules over tool classes (plan T3.1). A single tool call is rarely the
 * problem; the sequence is: read a secret, then send it somewhere. Every call is classified
 * from the scope vocabulary of `idempotent-dispatch.ts` plus what its arguments touch, and a
 * rule says what may follow what within the last `within` calls of the same run.
 *
 * The class names are the app's own MCP policy vocabulary (`apps/web/lib/mcp-policy.ts`
 * MCP_TOOL_POLICY_CLASSES) extended with the scope classes the Trent adapters carry
 * (`execute`, `external_send`, `network`). They are redeclared here because core cannot import
 * `apps/web` from governance without loading the app's graph.
 *
 * The evaluator is pure: history in, decision out. `policy-dispatch.ts` owns the per-run rings.
 */
import { z } from "zod";
import { dangerous, floorBlock } from "../tools/approval-floors.js";

export const POLICY_CLASSES = ["read_only", "write", "execute", "external_send", "network", "secret_access", "destructive", "money_moving", "deploy", "customer_facing"] as const;
export const PolicyClassSchema = z.enum(POLICY_CLASSES);
export type PolicyClass = z.infer<typeof PolicyClassSchema>;

export const DEFAULT_WINDOW = 20;

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  effect: z.enum(["deny", "require_approval"]),
  /** The class of the call being made. */
  when: PolicyClassSchema,
  /** When set, the current call must carry this class as well (`write` that is also `secret_access`). */
  also: PolicyClassSchema.optional(),
  /** When set, the rule fires only if a call of this class sits within the last `within` calls. */
  after: PolicyClassSchema.optional(),
  within: z.number().int().positive().default(DEFAULT_WINDOW),
  /** Shown to the seat in the blocked or needs_approval summary. */
  reason: z.string().min(1),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicyRuleInput = z.input<typeof PolicyRuleSchema>;

/** One entry of a run's tool-call history, as the evaluator sees it. */
export interface PolicyCall {
  readonly tool: string;
  readonly classes: readonly PolicyClass[];
  /** Epoch milliseconds; kept for the audit trail, not consulted by the window (which counts calls). */
  readonly at: number;
}

export interface PolicyDecision {
  readonly effect: PolicyRule["effect"];
  readonly rule: PolicyRule;
}

export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = [
  { id: "send-after-secret", effect: "deny", when: "external_send", after: "secret_access", within: DEFAULT_WINDOW, reason: "a secret was read earlier in this run; nothing leaves the machine until a new run starts" },
  { id: "network-after-secret", effect: "require_approval", when: "network", after: "secret_access", within: DEFAULT_WINDOW, reason: "a secret was read earlier in this run; a human confirms any network call that could carry it" },
  { id: "destructive-after-network", effect: "require_approval", when: "destructive", after: "network", within: DEFAULT_WINDOW, reason: "destructive command after external content was fetched; a human rules out an injected instruction" },
  { id: "execute-after-network", effect: "require_approval", when: "execute", after: "network", within: 5, reason: "execution right after external content was fetched; a human rules out an injected instruction" },
  { id: "money-needs-approval", effect: "require_approval", when: "money_moving", within: DEFAULT_WINDOW, reason: "money-moving calls always go through a human" },
  { id: "no-secret-writes", effect: "deny", when: "write", also: "secret_access", within: DEFAULT_WINDOW, reason: "seats never write secret files; rotate credentials by hand" },
];

/** Config rules append; a config rule carrying a default's id replaces it in place. */
export function mergeRules(defaults: readonly PolicyRule[], overrides: readonly PolicyRule[]): PolicyRule[] {
  const merged = defaults.map((rule) => overrides.find((candidate) => candidate.id === rule.id) ?? rule);
  for (const rule of overrides) if (!defaults.some((base) => base.id === rule.id)) merged.push(rule);
  return merged;
}

export class PolicyEvaluator {
  readonly rules: readonly PolicyRule[];
  /** The longest look-back any rule needs: a history ring smaller than this loses matches. */
  readonly window: number;

  constructor(rules: readonly PolicyRule[] = DEFAULT_POLICY_RULES) {
    this.rules = rules;
    this.window = rules.reduce((max, rule) => Math.max(max, rule.within), 1);
  }

  /** The strongest matching rule for `current` given the calls before it, newest last. Deny beats require_approval. */
  evaluate(current: readonly PolicyClass[], history: readonly PolicyCall[]): PolicyDecision | undefined {
    let pending: PolicyDecision | undefined;
    for (const rule of this.rules) {
      if (!current.includes(rule.when)) continue;
      if (rule.also !== undefined && !current.includes(rule.also)) continue;
      if (rule.after !== undefined && !history.slice(-rule.within).some((call) => call.classes.includes(rule.after!))) continue;
      if (rule.effect === "deny") return { effect: "deny", rule };
      pending ??= { effect: "require_approval", rule };
    }
    return pending;
  }
}

export interface ClassifiableCall {
  readonly adapter: string;
  readonly scopes: readonly string[];
  /** The `<tool>` head of the action, lowercased; empty for a bare JSON action. */
  readonly tool: string;
  readonly args: unknown;
}

/** Whole-token matches over a name normalised to `a_b_c`, so `postgres` is not `post` and `budget` is not `get`. */
function tokenRule(words: readonly string[], cls: PolicyClass): readonly [RegExp, PolicyClass] {
  return [new RegExp(`(?:^|_)(?:${words.join("|")})(?:_|$)`), cls];
}

const NAME_CLASSES: ReadonlyArray<readonly [RegExp, PolicyClass]> = [
  tokenRule(["read", "search", "list", "get", "view", "lookup", "inspect", "describe"], "read_only"),
  tokenRule(["write", "patch", "edit", "create", "update", "append", "manage", "set", "add"], "write"),
  tokenRule(["execute", "exec", "terminal", "process", "code", "run"], "execute"),
  tokenRule(["send", "email", "message", "post", "publish", "notify", "reply", "sms"], "external_send"),
  tokenRule(["network", "web", "browser", "http", "fetch", "download", "upload", "curl"], "network"),
  tokenRule(["secret", "secrets", "token", "tokens", "credential", "credentials", "password", "api_key", "apikey", "private_key"], "secret_access"),
  tokenRule(["delete", "destroy", "remove", "purge", "drop", "revoke", "truncate"], "destructive"),
  tokenRule(["charge", "refund", "payment", "payout", "transfer", "invoice", "stripe", "checkout", "billing"], "money_moving"),
  tokenRule(["deploy", "release", "rollback"], "deploy"),
  tokenRule(["customer", "contact", "lead", "crm", "ticket"], "customer_facing"),
];

/** `read_only` is dropped when the call also does something: `web_search` is a network call, not a read. */
const ACTION_CLASSES: ReadonlySet<PolicyClass> = new Set(["write", "execute", "external_send", "network", "destructive", "money_moving", "deploy"]);

const SECRET_ARG = /(^|[\\/\s"'=:])\.env(\.[\w.-]*)?(?=$|[\\/\s"'])|id_(?:rsa|ed25519|ecdsa|dsa)\b|\.(?:pem|p12|pfx|key|netrc|pgpass|npmrc|pypirc)\b|\bsecrets?\b|\bcredentials?\b|\btokens?\b|\bpassword\b|api[_-]?key|private[_ -]?key/i;
const DESTRUCTIVE_ARG = /\brm\s+-[a-z]*[rf][a-z]*\b|\bdrop\s+(?:table|database|schema|index)\b|\btruncate\s+table\b|\bdelete\s+from\b|git\s+push\b[^\n]*(?:--force|\s-f\b)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f/i;
const DESTRUCTIVE_FINDING = /delete|drop|truncate|force|reset --hard|kill|format|block device|fork bomb|shutdown|reboot|uninstall|clean/i;
const MAX_ARG_DEPTH = 3;

function stringsOf(value: unknown, depth: number, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (depth < MAX_ARG_DEPTH && value !== null && typeof value === "object") {
    for (const item of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) stringsOf(item, depth + 1, out);
  }
}

function destructiveCommand(text: string): boolean {
  if (DESTRUCTIVE_ARG.test(text)) return true;
  const floor = floorBlock(text);
  if (floor !== null) return true;
  return dangerous(text).some((finding) => DESTRUCTIVE_FINDING.test(finding));
}

/**
 * The classes of one call: from the tool name, else the adapter name, else the adapter's scope
 * list (the first level that yields a class wins), then from what the arguments touch.
 */
export function classifyCall(call: ClassifiableCall): PolicyClass[] {
  const classes = new Set<PolicyClass>();
  for (const name of [call.tool, call.adapter, call.scopes.join(" ")]) {
    const normalised = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    for (const [re, cls] of NAME_CLASSES) if (re.test(normalised)) classes.add(cls);
    if (classes.size > 0) break;
  }
  const texts: string[] = [];
  stringsOf(call.args, 0, texts);
  if (texts.some((text) => SECRET_ARG.test(text))) classes.add("secret_access");
  if (texts.some((text) => destructiveCommand(text))) classes.add("destructive");
  if ([...classes].some((cls) => ACTION_CLASSES.has(cls))) classes.delete("read_only");
  return POLICY_CLASSES.filter((cls) => classes.has(cls));
}
