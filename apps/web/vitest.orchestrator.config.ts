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
    setupFiles: [],
    include: ["lib/orchestrator*.test.ts", "lib/cycles.test.ts"],
    exclude: ["**/node_modules/**", "**/.worktrees/**"],
  },
});
