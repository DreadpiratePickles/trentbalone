import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "lib/**", "app/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./apps/web"),
      "@trent/core": path.resolve(__dirname, "./packages/trent-core/src"),
    },
  },
});
