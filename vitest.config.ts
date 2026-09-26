import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Opt-in switch for the network-backed `*.live.test.ts` suites (see the exclude list below).
 * `npm run test:live` sets it; the default `npm test` does not.
 */
const includeLiveTests = process.env.TRENT_TEST_LIVE === "1";

/**
 * Root Vitest config — covers OUR code only: `packages/trent-core` and `apps/cli`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY `apps/web` IS EXCLUDED HERE — DO NOT "HELPFULLY" RE-INCLUDE IT
 * ────────────────────────────────────────────────────────────────────────────
 * `apps/web` is a Next.js app with its OWN vitest config, its OWN setup file, its
 * OWN `next/server` alias and an implicit working directory of `apps/web`. When
 * the root run swept it up, ~2900 web tests executed WITHOUT any of that, which
 * produced pure phantom failures that say nothing about the code:
 *
 *   • apps/web/gbrain/server.test.mjs      -> "No test suite found"
 *     (it needs the web project's setup/transform to register its suite)
 *   • apps/web/railway.config.test.ts      -> reads `railway.json` by a RELATIVE
 *     path, which only resolves when cwd is `apps/web`, not the repo root.
 *
 * `apps/web` is fully tested by its own script, which passes 505 files / 2743
 * tests:  `cd apps/web && npm test`
 *         (`vitest run --pool=forks --poolOptions.forks.singleFork=true`)
 * From the repo root use `npm run test:web`, or `npm run test:all` for both.
 *
 * So: web coverage is NOT lost by this exclusion — it is delegated to the only
 * config that can run it correctly. Re-including it here re-creates the phantom
 * failures and nothing else.
 */
/**
 * Two files run alone. desktop.test.ts drives `hdiutil`, which mounts disk images serially on macOS;
 * a concurrent mount contends and a failed run leaves a stale volume that blocks later ones.
 * browser.attach.chromium.test.ts holds a real Chrome: started beside the whole parallel suite on a
 * 4-vCPU runner it once took longer than 30 s to open its DevTools port (run 36228798388).
 * Vitest 3.2.7 drops a per-project `fileParallelism` (a NonProjectOptions key); the per-project knob
 * the shared forks pool reads is `poolOptions.forks.singleFork`: these files run in one fork, one at a
 * time, after the parallel files finish (vitest/dist/chunks/coverage.DfSpMS-b.js:2674-2708).
 */
const EXCLUSIVE = [
  "apps/cli/src/commands/__tests__/desktop.test.ts",
  "packages/trent-core/src/tools/browser/browser.attach.chromium.test.ts",
];

const ROOT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "apps/web/**",
  "apps/desktop/**",
  "lib/**",
  "app/**",
  ...(includeLiveTests ? [] : ["**/*.live.test.{ts,tsx,mts,js,mjs}", "**/live.*.test.{ts,tsx,mts,js,mjs}"]),
];

export default defineConfig({
  test: {
    environment: "node",
    // Allow-list, not a deny-list: only our two workspaces are ever collected.
    include: [
      "packages/trent-core/src/**/*.{test,spec}.{ts,tsx,mts,js,mjs}",
      "apps/cli/src/**/*.{test,spec}.{ts,tsx,mts,js,mjs}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Belt-and-braces: even if `include` is ever widened, these stay out.
      "apps/web/**",
      "apps/desktop/**",
      "lib/**",
      "app/**",
      /**
       * Live suites call real third-party model providers over the network. Two naming
       * conventions exist in this repo, so both are matched:
       *   packages/trent-core/src/doctor/providers.live.test.ts
       *   packages/trent-core/src/model-gateway/ModelGateway.live.test.ts
       *   apps/cli/src/repl/__tests__/live.gemini.test.ts
       * Those suites
       * are real and worth keeping, but they fail for reasons that have nothing to do with this
       * repo — most often an HTTP 429 from the provider when the key is rate-limited. A shared
       * default `npm test` must fail only on OUR bugs, so the live suites get their own script:
       *   npm run test:live
       */
      ...(includeLiveTests
        ? []
        : [
            "**/*.live.test.{ts,tsx,mts,js,mjs}",
            "**/live.*.test.{ts,tsx,mts,js,mjs}",
          ]),
    ],
    /**
     * These are not pure unit tests: they shell out to `docker`, spawn `node` scripts, derive
     * Prisma schemas and walk `apps/web/lib`. Vitest forks one worker per core, so during a full
     * run every one of those subprocesses competes for the same CPU. Measured here, suites that
     * take 0.6 s - 3.9 s alone took 7.3 s - 22.8 s under a saturated machine and tripped the 5 s
     * default, producing failures that were pure scheduling artifacts. The work is I/O- and
     * subprocess-bound, so a wall-clock budget of 5 s was never the right unit.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        // An explicit exclude REPLACES the inherited one, so it must carry the root list too,
        // or the live suites leak back into the default run.
        test: { name: "parallel", exclude: [...ROOT_EXCLUDE, ...EXCLUSIVE] },
      },
      {
        // Deliberately NOT `extends: true`. Inheriting the root config merges its include glob
        // into this project, so a CLI path filter collects every matched file here too and each
        // test runs twice. This project is self-contained and owns exactly its two files.
        test: {
          name: "exclusive",
          environment: "node",
          include: EXCLUSIVE,
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "./apps/web"),
            "@trent/core": path.resolve(__dirname, "./packages/trent-core/src"),
          },
        },
      },
    ],
  },
  resolve: {
    alias: {
      // Load-bearing: `packages/trent-core/src/**` wrapper modules (agents, evals,
      // gepa, marketplace, mcp, readiness, traces, skills/foundry, model-gateway,
      // orchestrator, runtime) re-export implementations from `apps/web/lib/**`
      // via `@/lib/...`. We do not RUN apps/web's tests here, but we do IMPORT
      // its source, so this alias must stay.
      "@": path.resolve(__dirname, "./apps/web"),
      "@trent/core": path.resolve(__dirname, "./packages/trent-core/src"),
    },
  },
});
