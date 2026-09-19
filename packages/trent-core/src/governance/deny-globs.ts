/**
 * `approvals.deny`: user globs over the same subjects the hardline list sees — the terminal or
 * process command string, and the file paths a tool would touch. A match is refused with the glob
 * named, at every autonomy level, so the user can add a rule of their own below the shipped list
 * without editing code.
 *
 * Glob dialect, deliberately one rule rather than three: `*` and `**` both match any run of
 * characters INCLUDING `/`, `?` matches exactly one character, and everything else is literal.
 * Path globbing usually makes `*` stop at a separator, but these globs are matched against
 * command strings as often as against paths, and `*rm -rf /tmp*` failing because the command
 * contains a slash is a footgun that costs more than the precision is worth. Matching ignores
 * case, so a shouted command cannot walk past a user's rule. `~` expands against home.
 */

export interface DenyHit {
  readonly glob: string;
  readonly subject: string;
}

/** Anchored, case-insensitive, regex metacharacters literal except the three glob operators. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      // `**` is the same as `*` here; consume the run so the source stays small.
      while (glob[i + 1] === "*") i += 1;
      source += "[\\s\\S]*";
    } else if (char === "?") source += "[\\s\\S]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

const cache = new Map<string, RegExp>();
const MAX_CACHE = 256;

function compiled(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  const re = globToRegExp(glob);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(glob, re);
  return re;
}

function expandHome(value: string, home: string | undefined): string {
  if (home === undefined || home === "") return value;
  return value.replace(/^~(?=\/|$)/, home);
}

/**
 * The first configured glob that matches any subject, so the reported rule is stable across runs
 * rather than whichever subject happened to be extracted first.
 */
export function denyMatch(globs: readonly string[], subjects: readonly string[], home?: string): DenyHit | null {
  for (const glob of globs) {
    const re = compiled(expandHome(glob, home));
    for (const subject of subjects) {
      if (re.test(subject)) return { glob, subject };
    }
  }
  return null;
}
