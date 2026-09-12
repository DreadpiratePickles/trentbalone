import { defineConfig } from "vitest/config";

/**
 * apps/desktop has its own config because the ROOT vitest config explicitly
 * excludes `apps/desktop/**` (see the comment block in ../../vitest.config.ts).
 * Run with: `cd apps/desktop && npm test`. Rust-side unit tests are separate:
 * `npm run test:rust`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
