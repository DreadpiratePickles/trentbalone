/**
 * The hardline blocklist: shipped in code, evaluated BEFORE any approval logic, and refused at
 * every autonomy level, behind any `--yolo`-style flag, and after any "always approve" answer.
 *
 * THIS IS A GUARDRAIL, NOT A SANDBOX. It raises the cost of an accident and of an obvious
 * injected instruction. It does not contain an attacker who already runs code as the user: a
 * command string can always be spelled another way, and a rule that matched every spelling would
 * refuse ordinary work. The containment boundary is the sandbox (`tools/sandbox.ts`) and the
 * egress proxy; this list is the layer above it that says "not even once, not even approved".
 *
 * Every rule is matched over the DEOBFUSCATED command variants the approval floor already
 * generates (`tools/approval-floors.ts` detectionVariants: NFKC, ANSI and escape strip, `$IFS`,
 * env unwrap, basename projection, `sh -c` payloads), so `r\m -rf /` and `rm${IFS}-rf${IFS}~`
 * reach the same rule as the plain spelling. Rules that could otherwise fire on prose are matched
 * over the quote-masked variants, so `git commit -m 'never rm -rf /'` is a commit, not a refusal.
 *
 * One list, one test per entry, each with a positive AND a negative case: `hardline.test.ts`.
 */
import path from "node:path";
import { CMDPOS } from "../tools/approval-patterns.js";
import { detectionVariants, maskQuoted } from "../tools/approval-floors.js";

export type HardlineAccess = "read" | "write";

/** What a rule is shown: the command a tool would run, or a path a tool would touch. */
export type HardlineSubject =
  | { readonly kind: "command"; readonly value: string }
  | { readonly kind: "path"; readonly value: string; readonly access: HardlineAccess };

export interface HardlineContext {
  /** Home directory the `~` and `$HOME` spellings resolve against. */
  readonly home: string;
  /** `~/.trent/<profile>`; a recursive delete of it, and a write to its `.env`, are refused. */
  readonly profileDir: string;
}

export interface HardlineHit {
  readonly id: string;
  readonly reason: string;
}

export interface HardlineRule {
  readonly id: string;
  readonly reason: string;
  matches(subject: HardlineSubject, ctx: HardlineContext): boolean;
}

/**
 * Branches a force push may never rewrite. Deliberately a shipped constant and not a config key:
 * a protected-branch list a tool call could edit is not a protected-branch list.
 */
export const PROTECTED_BRANCHES: readonly string[] = ["main", "master", "trunk", "develop", "release", "production", "prod"];

/** Egress material: owning these is owning every intercepted TLS session and the proxy token. */
const EGRESS_FILES: ReadonlySet<string> = new Set(["ca.key", "ca.crt", "tokens.json"]);

/** Raw block devices. A write here is not recoverable by anything Trent can do afterwards. */
const DEVICE = String.raw`/dev/(?:sd|nvme|hd|mmcblk|vd|xvd|r?disk)[a-z0-9]*`;

const SHELL = String.raw`(?:ba|z|k|da)?sh`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every deobfuscated spelling of a command, each also in a quote-masked form. */
interface CommandView {
  readonly variants: ReadonlySet<string>;
  readonly masked: ReadonlySet<string>;
}

const viewCache = new Map<string, CommandView>();
const MAX_VIEW_CACHE = 64;

function viewOf(command: string): CommandView {
  const cached = viewCache.get(command);
  if (cached) return cached;
  const variants = detectionVariants(command);
  const masked = new Set<string>();
  for (const variant of variants) masked.add(maskQuoted(variant));
  const view: CommandView = { variants, masked };
  if (viewCache.size >= MAX_VIEW_CACHE) viewCache.delete(viewCache.keys().next().value as string);
  viewCache.set(command, view);
  return view;
}

function anyMatch(source: Iterable<string>, re: RegExp): boolean {
  for (const text of source) if (re.test(text)) return true;
  return false;
}

/** `~`, `$HOME` and `${HOME}` resolved, separators normalised, `..` collapsed. Never touches disk. */
export function normaliseTarget(value: string, ctx: HardlineContext): string {
  const bare = value.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  const home = ctx.home.replace(/\\/g, "/");
  const expanded = bare.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME/g, home);
  const collapsed = path.posix.normalize(expanded);
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

function under(target: string, directory: string): boolean {
  const dir = directory.replace(/\\/g, "/").replace(/\/$/, "");
  return target === dir || target.startsWith(`${dir}/`);
}

/** Path-ish words in a command: `~/...`, `$HOME/...`, `/abs`, `./rel` and `../rel`. */
const PATH_TOKEN = /(?:^|[\s;|&<>()"'`=])((?:~|\$HOME|\$\{HOME\}|\.{0,2}\/)[^\s;|&<>()"'`]*)/g;

function pathTokens(view: CommandView): string[] {
  const out: string[] = [];
  for (const text of view.masked) {
    for (const match of text.matchAll(PATH_TOKEN)) {
      const token = match[1];
      if (token !== undefined && token !== "") out.push(token);
    }
  }
  return out;
}

/** True when a command does something that could overwrite the token it names. */
const WRITE_VERB = new RegExp(
  [
    String.raw`>`,
    String.raw`(?:^|[\s;|&\n])(?:tee|cp|mv|install|truncate|touch|ln|rm|chmod|chown|shred)\b`,
    String.raw`\bsed\s+(?:-[^\s]*i|--in-place)\b`,
    String.raw`\bdd\b[^\n]*\bof=`,
  ].join("|"),
  "i",
);

function isTrentWriteTarget(target: string, ctx: HardlineContext): boolean {
  const trentDir = normaliseTarget(path.posix.join(ctx.home.replace(/\\/g, "/"), ".trent"), ctx);
  const inTrent = under(target, trentDir) || under(target, normaliseTarget(ctx.profileDir, ctx));
  if (!inTrent) return false;
  const base = path.posix.basename(target);
  if (base === ".env" || base === "workspace-trust.json") return true;
  return EGRESS_FILES.has(base) && target.includes("/egress/");
}

function isTrentReadTarget(target: string, ctx: HardlineContext): boolean {
  const home = ctx.home.replace(/\\/g, "/");
  if (under(target, normaliseTarget(path.posix.join(home, ".ssh"), ctx))) return true;
  const trentDir = normaliseTarget(path.posix.join(home, ".trent"), ctx);
  const inTrent = under(target, trentDir) || under(target, normaliseTarget(ctx.profileDir, ctx));
  return inTrent && path.posix.basename(target) === ".env";
}

/** The delete targets that have no recovery path: root, home, `~/.trent`, this profile. */
function deleteTargets(ctx: HardlineContext): string {
  const home = escapeRegExp(ctx.home.replace(/\\/g, "/"));
  const profile = escapeRegExp(ctx.profileDir.replace(/\\/g, "/"));
  return [
    String.raw`/\*?`,
    String.raw`(?:~|\$HOME|\$\{HOME\})/?\*?`,
    String.raw`(?:~|\$HOME|\$\{HOME\})/\.trent(?:/\S*)?`,
    `${home}/?\\*?`,
    `${profile}(?:/\\S*)?`,
  ].join("|");
}

const RM_PREFIX = `${CMDPOS}rm\\s+(?:-[^\\s]*\\s+)*`;
const TAIL = String.raw`(?:\s|$|[)\`;|&])`;

/** Whitespace words of a command, for the rules that compare operands rather than shapes. */
function words(view: CommandView): string[] {
  const out: string[] = [];
  for (const text of view.masked) for (const word of text.split(/[\s]+/)) if (word !== "") out.push(word);
  return out;
}

function branchOf(word: string): string {
  const withoutForce = word.replace(/^\+/, "");
  const afterColon = withoutForce.includes(":") ? withoutForce.slice(withoutForce.lastIndexOf(":") + 1) : withoutForce;
  return afterColon.replace(/^refs\/heads\//, "");
}

const FORCE_LONG = /--force(?!-with-lease)\b/i;
const FORCE_SHORT = /(?:^|\s)-(?!-)[a-z]*f[a-z]*(?=\s|$)/i;
const PUSH_REFSPEC_FORCE = /(?:^|\s)\+\S+/;

function commandRule(id: string, reason: string, sources: readonly RegExp[], quoteMasked = false): HardlineRule {
  return {
    id,
    reason,
    matches(subject) {
      if (subject.kind !== "command") return false;
      const view = viewOf(subject.value);
      const texts = quoteMasked ? view.masked : view.variants;
      return sources.some((re) => anyMatch(texts, re));
    },
  };
}

/**
 * The list. Order is the order a hit is reported in, so the most specific reason wins: the
 * recursive-delete rule sits above the secret-write rule because `rm -rf ~/.trent` is a delete.
 */
export const HARDLINE_RULES: readonly HardlineRule[] = [
  {
    id: "recursive-delete-of-root-home-or-profile",
    reason: "a recursive delete of the root filesystem, the home directory or the Trent profile has no recovery path",
    matches(subject, ctx) {
      if (subject.kind !== "command") return false;
      const re = new RegExp(`${RM_PREFIX}(?:${deleteTargets(ctx)})${TAIL}`, "is");
      return anyMatch(viewOf(subject.value).variants, re);
    },
  },
  commandRule(
    "download-piped-into-a-shell",
    "piping a download straight into a shell runs code nobody has read, from a host nobody has vouched for",
    [
      new RegExp(String.raw`\b(?:curl|wget|fetch)\b[^\n]*\|\s*(?:[\w./-]*/)?${SHELL}\b`, "is"),
      new RegExp(String.raw`\b${SHELL}\s+<\s*<?\s*\(\s*(?:curl|wget)\b`, "is"),
      new RegExp(String.raw`\b${SHELL}\s+(?:-[a-z]+\s+)*-[a-z]*c[a-z]*\s+["']?\s*\$\(\s*(?:curl|wget)\b`, "is"),
      new RegExp(String.raw`(?:\beval\b|\bsource\b)\s*(?:\$\(\s*|\`\s*)(?:curl|wget)\b`, "is"),
    ],
  ),
  commandRule(
    "chmod-or-chown-on-root",
    "changing the permissions or the owner of the whole root filesystem leaves the machine unusable",
    [new RegExp(`${CMDPOS}(?:chmod|chown)\\s+(?:-[^\\s]+\\s+)*[^\\s]+\\s+/\\*?${TAIL}`, "is")],
  ),
  commandRule(
    "write-to-a-raw-disk-device",
    "writing to a raw disk or partition destroys every filesystem on it, including the one this process runs from",
    [
      new RegExp(String.raw`\bdd\b[^\n]*\bof=${DEVICE}`, "is"),
      new RegExp(String.raw`>\s*${DEVICE}\b`, "is"),
      new RegExp(`${CMDPOS}mkfs(?:\\.[a-z0-9]+)?\\b`, "is"),
    ],
    true,
  ),
  commandRule(
    "fork-bomb",
    "a self-piping background function exhausts the process table and takes the machine down with it",
    [/([\w:]+)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1\s*&/],
    true,
  ),
  {
    id: "write-to-trent-secrets",
    reason: "a tool may never write Trent's own .env, the egress CA and token files, or the workspace trust record",
    matches(subject, ctx) {
      if (subject.kind === "path") return subject.access === "write" && isTrentWriteTarget(normaliseTarget(subject.value, ctx), ctx);
      const view = viewOf(subject.value);
      if (!anyMatch(view.masked, WRITE_VERB)) return false;
      return pathTokens(view).some((token) => isTrentWriteTarget(normaliseTarget(token, ctx), ctx));
    },
  },
  {
    id: "read-trent-env-or-ssh-keys",
    reason: "a tool may never read Trent's own .env or anything under ~/.ssh; those credentials are not the model's to hold",
    matches(subject, ctx) {
      if (subject.kind === "path") return subject.access === "read" && isTrentReadTarget(normaliseTarget(subject.value, ctx), ctx);
      return pathTokens(viewOf(subject.value)).some((token) => isTrentReadTarget(normaliseTarget(token, ctx), ctx));
    },
  },
  {
    id: "force-push-to-a-protected-branch",
    reason: "a force push to a protected branch rewrites history other people have already pulled",
    matches(subject) {
      if (subject.kind !== "command") return false;
      const view = viewOf(subject.value);
      for (const text of view.masked) {
        for (const match of text.matchAll(/\bgit\s+push\b([^\n;|&]*)/gi)) {
          const rest = match[1] ?? "";
          const forced = FORCE_LONG.test(rest) || FORCE_SHORT.test(rest) || PUSH_REFSPEC_FORCE.test(rest);
          if (!forced) continue;
          const named = rest.split(/\s+/).filter((word) => word !== "" && !word.startsWith("-"));
          if (named.some((word) => PROTECTED_BRANCHES.includes(branchOf(word).toLowerCase()))) return true;
        }
      }
      return false;
    },
  },
];

/** The first rule any subject trips, or null when the call may proceed to the approval layer. */
export function hardlineBlock(subjects: readonly HardlineSubject[], ctx: HardlineContext): HardlineHit | null {
  for (const rule of HARDLINE_RULES) {
    for (const subject of subjects) {
      if (rule.matches(subject, ctx)) return { id: rule.id, reason: rule.reason };
    }
  }
  return null;
}
