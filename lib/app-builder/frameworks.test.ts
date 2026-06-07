import { describe, expect, it } from "vitest";
import { detectFrameworks, detectLanguages, getFrameworkCapability, recommendScaffold } from "./frameworks";

describe("app builder framework intelligence", () => {
  it("detects supported web and mobile frameworks from package metadata and files", () => {
    const result = detectFrameworks({
      packageJson: {
        dependencies: {
          next: "15.0.0",
          "@remix-run/react": "2.0.0",
          "@sveltejs/kit": "2.0.0",
          astro: "5.0.0",
          nuxt: "4.0.0",
          expo: "53.0.0",
        },
      },
      files: ["pubspec.yaml"],
    });

    expect(result).toEqual(["nextjs", "remix", "sveltekit", "astro", "nuxt", "expo", "flutter"]);
  });

  it("detects supported languages from file extensions", () => {
    expect(detectLanguages([
      "app/page.tsx",
      "scripts/train.py",
      "cmd/server/main.go",
      "app/models/user.rb",
      "src/lib.rs",
      "lib/main.dart",
    ])).toEqual(["typescript", "python", "go", "ruby", "rust", "dart"]);
  });

  it("returns scaffold recommendations for framework capabilities", () => {
    expect(getFrameworkCapability("nextjs").supportsServerRoutes).toBe(true);
    expect(recommendScaffold("expo")).toEqual(expect.objectContaining({
      packageManager: "npm",
      devCommand: "npx expo start",
      testCommand: "npm test",
    }));
  });
});
