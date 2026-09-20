/**
 * [C1] Can the wrapped app's store work in this process? One answer, consulted by everyone.
 *
 * `apps/web/lib/store.ts:11` selects the Prisma store whenever `DATABASE_URL` is truthy, and
 * `apps/web/lib/db.ts:8` builds that client — `new PrismaClient()` — for a POSTGRESQL datasource.
 * The wrapper's own durable store is SQLite under `<profile>/trent.db`, opened through its own
 * generated client and `bun:sqlite`; its URL is NOT the app's, and until this module the standalone
 * runtime exported it as the app's `DATABASE_URL`. Two things followed, both measured
 * (docs/sessions/2026-09-20-w1.1-run-prisma-app-store.md):
 *
 *   - from source under Bun every app-store call — `ensureCompany` first — failed on
 *     `the URL must start with the protocol postgresql://`, so `trent run` never started a run;
 *   - from the compiled binary the variable stays unset, so the app runs on its in-process store,
 *     but the first `import("@/lib/store")` still constructs the Postgres client, whose engine
 *     constructor starts loading a query-engine library as a promise nothing awaits. On any
 *     machine that is not the one that built the binary the library is not found, the promise
 *     rejects unhandled, and Bun kills `trent run` mid-stream with
 *     `PrismaClientInitializationError` on stderr (binary.yml's Linux RUN job).
 *
 * So the rule is decided here, once, from the URL alone and before any `import("@/lib/*")`:
 * the app's tiers are USED only when `DATABASE_URL` is the app's own datasource, a postgres URL.
 * Unset and empty mean the in-process store, whose rows die with the process; a `file:` URL is
 * the wrapper's SQLite store, which the app's client cannot open; any other scheme is not the
 * app's datasource either. In every one of those states the readers answer nothing, the writers
 * write nothing and report no failure, and `trent doctor` prints the one reason (`App Memory
 * Tiers`). Nothing here reads a value into a message: a URL can carry a password.
 *
 * `guardAppDatabase` is the other half. `db.ts` reads `globalThis.__prisma ?? new PrismaClient()`,
 * the app's own hot-reload seam, so a surface that knows the store is not usable fills the seam
 * before the app is imported and the Postgres client is never constructed: no engine load, no
 * unhandled rejection, and any accidental use throws a plain error that names the reason.
 */

/** The app-side store kind, from the URL alone. */
export type AppStoreKind = "memory" | "sqlite" | "server" | "unsupported";

export type AppStoreState =
  | { readonly usable: true; readonly store: "server"; readonly url: string }
  | { readonly usable: false; readonly store: Exclude<AppStoreKind, "server">; readonly reason: string };

/** The one variable the decision is made from. `process.env` satisfies it. */
export interface AppStoreEnv {
  readonly DATABASE_URL?: string;
}

/** The app's datasource is postgresql (`apps/web/prisma/schema.prisma`); Accelerate's scheme rides on it. */
const POSTGRES_SCHEMES = ["postgres:", "postgresql:", "prisma+postgres:"] as const;

function schemeOf(url: string): string | undefined {
  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(url);
  return match?.[1]?.toLowerCase();
}

/** Where the app's store would go in this process, and whether the app tiers are used at all. */
export function describeAppStore(env: AppStoreEnv = process.env): AppStoreState {
  // The same truthiness test as `store.ts:11`, with whitespace treated as nothing configured.
  const raw = env.DATABASE_URL;
  const url = raw === undefined ? "" : raw.trim();
  if (url === "") {
    return {
      usable: false,
      store: "memory",
      reason:
        "DATABASE_URL is unset, so the app's store is in-process and a tier row would not outlive this process; " +
        "seats read and write this profile's own memory (the blocks, the brain, the runs, the skills and the playbook) instead",
    };
  }
  const scheme = schemeOf(url);
  if (scheme === "file:") {
    return {
      usable: false,
      store: "sqlite",
      reason:
        "DATABASE_URL names a SQLite file, which is the wrapper's own store format and not the app's: " +
        "the app's client is built for postgresql, so its tiers are skipped rather than handed a URL they cannot open",
    };
  }
  if (scheme !== undefined && (POSTGRES_SCHEMES as readonly string[]).includes(scheme)) {
    return { usable: true, store: "server", url };
  }
  return {
    usable: false,
    store: "unsupported",
    reason: `DATABASE_URL uses the scheme \`${scheme ?? "(none)"}\`; the app's client is built for postgresql, so its tiers are skipped`,
  };
}

/** True when the app's tiers may be read and written in this process. */
export function appStoreUsable(env: AppStoreEnv = process.env): boolean {
  return describeAppStore(env).usable;
}

/**
 * Thrown by the module loaders (`loadAppMemoryModules`, `loadAppWriteModules`) BEFORE any import
 * when the store is not usable. A writer handed it reports "nothing written, no failure": the skip
 * is deliberate and the doctor already carries the reason.
 */
export class AppStoreUnusedError extends Error {
  readonly store: Exclude<AppStoreKind, "server">;

  constructor(state: Extract<AppStoreState, { usable: false }>) {
    super(`the app's company memory is not used: ${state.reason}`);
    this.name = "AppStoreUnusedError";
    this.store = state.store;
  }
}

const PRISMA_SEAM = "__prisma";
const GUARD_TAG = "TrentAppDatabaseGuard";
const GUARD_MARK: unique symbol = Symbol.for("trent.app-database-guard");

interface GlobalWithSeam {
  [PRISMA_SEAM]?: unknown;
}

/** True when `value` is the guard this module installed (and not the app's real client). */
export function isAppDatabaseGuard(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[GUARD_MARK] === true;
}

/** Property reads that must not throw: `??` and `await` on the seam, inspection, and identity. */
const INERT_KEYS = new Set<string | symbol>(["then", "catch", "finally", "constructor", "toJSON", "valueOf", "toString"]);

function createGuard(state: Extract<AppStoreState, { usable: false }>): object {
  const target = Object.create(null) as Record<string | symbol, unknown>;
  target[GUARD_MARK] = true;
  target[Symbol.toStringTag] = GUARD_TAG;
  target.toString = () => `[${GUARD_TAG}: ${state.store}]`;
  target.valueOf = () => target;
  return new Proxy(target, {
    get(self, key) {
      if (typeof key === "symbol" || INERT_KEYS.has(key)) return self[key];
      throw new AppStoreUnusedError(state);
    },
    has(self, key) {
      return key in self;
    },
  });
}

/**
 * Fills the app's singleton seam with a guard when the store is not usable, so `db.ts` never
 * constructs the Postgres client; removes the guard — and only the guard, never a client the app
 * built — when it is. Idempotent. Returns the state it acted on, so the caller can hand the app's
 * own URL on and print nothing else.
 */
export function guardAppDatabase(env: AppStoreEnv = process.env): AppStoreState {
  const state = describeAppStore(env);
  const scope = globalThis as GlobalWithSeam;
  const current = scope[PRISMA_SEAM];
  if (state.usable) {
    if (isAppDatabaseGuard(current)) delete scope[PRISMA_SEAM];
    return state;
  }
  // A client the app already built (the seam was reached before this ran) is left alone: its
  // engine load has already started, and replacing it would give the app two clients.
  if (current === undefined) scope[PRISMA_SEAM] = createGuard(state);
  return state;
}
