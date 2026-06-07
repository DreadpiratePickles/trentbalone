/**
 * Targeted vitest config for running new-phase unit tests in the Codex sandbox.
 * - No setupFiles (avoids Prisma/Redis connection at startup)
 * - Includes only the new test files added in recent phase merges
 * - Run: VITEST_SKIP_DB_RESET=1 node_modules/.bin/vitest run --config vitest.phase-new.config.ts
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

const root = __dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      "next/server": path.join(root, "lib/mocks/next-server.ts"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    setupFiles: [], // No DB setup — unit tests only
    include: [
      // Verified pure-function tests: no store/db/redis in test or impl
      "lib/ai-proxy/access-tier.test.ts",
      "lib/ai-proxy/embeddings.test.ts",
      "lib/ai-proxy/openai-compatible.test.ts",
      "lib/ai-proxy/provider-policy.test.ts",
      "lib/ai-proxy/rerank.test.ts",
      "lib/ai-proxy/smart-cache.test.ts",
      "lib/plug/schema-v2.test.ts",
      "lib/seat-output-schemas.test.ts",
      "lib/trench-wiki.test.ts",
      "lib/trench-search.test.ts",
      "lib/trenchpad.test.ts",
      "lib/control-plane-settings.test.ts",
      "components/control-plane-capabilities.test.ts",
      "components/wiki-client.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/.worktrees/**"],
  },
});
