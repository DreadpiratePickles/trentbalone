import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  STARTER_CONTEXT_FILES,
  STARTER_TEMPLATE,
  STARTER_UI_COMPONENTS,
} from "@/lib/workbench-starter-template";

const execFileAsync = promisify(execFile);

const REQUIRED_UI = [
  "badge",
  "button",
  "card",
  "dialog",
  "dropdown-menu",
  "input",
  "skeleton",
  "table",
  "tabs",
  "toast",
] as const;

describe("workbench starter template", () => {
  it("exposes shadcn context anchors for the build agent", () => {
    expect(STARTER_CONTEXT_FILES).toEqual([
      "src/globals.css",
      "tailwind.config.ts",
      "src/components/ui/index.ts",
      "src/App.tsx",
    ]);
  });

  it("ships Tailwind, globals.css, utils, and curated shadcn/ui primitives", () => {
    const pkg = JSON.parse(STARTER_TEMPLATE["package.json"] ?? "{}") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(STARTER_TEMPLATE["tailwind.config.ts"]).toContain("tailwindcss-animate");
    expect(STARTER_TEMPLATE["postcss.config.js"]).toContain("tailwindcss");
    expect(STARTER_TEMPLATE["src/globals.css"]).toContain("--background:");
    expect(STARTER_TEMPLATE["src/globals.css"]).toContain("--primary:");
    expect(STARTER_TEMPLATE["src/lib/utils.ts"]).toContain("tailwind-merge");
    expect(STARTER_TEMPLATE["src/main.tsx"]).toContain("./globals.css");
    expect(STARTER_TEMPLATE["vite.config.ts"]).toContain('alias');

    for (const name of REQUIRED_UI) {
      expect(STARTER_TEMPLATE[`src/components/ui/${name}.tsx`]).toBeTruthy();
    }
    expect(STARTER_UI_COMPONENTS).toEqual([...REQUIRED_UI]);

    expect(pkg.dependencies?.["class-variance-authority"]).toBeTruthy();
    expect(pkg.dependencies?.["@radix-ui/react-slot"]).toBeTruthy();
    expect(pkg.devDependencies?.tailwindcss).toBeTruthy();
    expect(pkg.devDependencies?.["tailwindcss-animate"]).toBeTruthy();
  });

  it("renders Button and Card in the default App shell", () => {
    const app = STARTER_TEMPLATE["src/App.tsx"] ?? "";
    expect(app).toContain('@/components/ui/button');
    expect(app).toContain('@/components/ui/card');
    expect(app).toContain("<Button");
    expect(app).toContain("<Card");
    expect(STARTER_TEMPLATE["src/App.css"]).toBeUndefined();
    expect(STARTER_TEMPLATE["src/index.css"]).toBeUndefined();
  });

  it(
    "scaffolds a project that typechecks and builds cleanly",
    async () => {
      const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-starter-"));
      try {
        for (const [filePath, content] of Object.entries(STARTER_TEMPLATE)) {
          const fullPath = path.join(workdir, filePath);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, "utf8");
        }

        await execFileAsync("npm", ["install", "--legacy-peer-deps"], {
          cwd: workdir,
          timeout: 120_000,
        });
        await execFileAsync("npm", ["run", "build"], {
          cwd: workdir,
          timeout: 120_000,
        });
      } finally {
        await fs.rm(workdir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
