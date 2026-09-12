/**
 * workbench-starter-template.ts
 *
 * The golden starter template that every new Workbench build session is seeded with.
 * Vite + React 18 + TypeScript + Tailwind + shadcn/ui.
 */

import {
  STARTER_APP,
  STARTER_GLOBALS_CSS,
  STARTER_INDEX_HTML,
  STARTER_MAIN,
  STARTER_PACKAGE_JSON,
  STARTER_POSTCSS_CONFIG,
  STARTER_TAILWIND_CONFIG,
  STARTER_TSCONFIG,
  STARTER_UTILS,
  STARTER_VITE_CONFIG,
} from "@/lib/workbench-starter-template-config";
import {
  STARTER_UI_COMPONENTS,
  starterUiTemplateFiles,
} from "@/lib/workbench-starter-template-ui";

export { STARTER_UI_COMPONENTS };

export const STARTER_TEMPLATE: Record<string, string> = {
  "package.json": STARTER_PACKAGE_JSON,
  "index.html": STARTER_INDEX_HTML,
  "vite.config.ts": STARTER_VITE_CONFIG,
  "tsconfig.json": STARTER_TSCONFIG,
  "postcss.config.js": STARTER_POSTCSS_CONFIG,
  "tailwind.config.ts": STARTER_TAILWIND_CONFIG,
  "src/globals.css": STARTER_GLOBALS_CSS,
  "src/lib/utils.ts": STARTER_UTILS,
  "src/main.tsx": STARTER_MAIN,
  "src/App.tsx": STARTER_APP,
  ...starterUiTemplateFiles(),
};

/** File paths the agent should be told about for context injection. */
export const STARTER_CONTEXT_FILES = [
  "src/globals.css",
  "tailwind.config.ts",
  "src/components/ui/index.ts",
  "src/App.tsx",
] as const;
