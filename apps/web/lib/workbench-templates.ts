/**
 * workbench-templates.ts — the Workbench template registry.
 *
 * Before this, every build session was seeded with a single Vite React SPA and
 * the agent was forbidden from writing a backend, a database, or an API. That
 * capped "complex thing from a simple prompt" at static front-ends. This registry
 * lets the build loop pick the right substrate from the objective:
 *
 *   - spa-react       → landing pages, calculators, todos, dashboards (no server)
 *   - fullstack-next  → products with auth + DB + API + UI (Next.js + Prisma + SQLite)
 *   - api-node        → REST APIs / webhook handlers / backend services (Hono + SQLite)
 *
 * Pure module: no store, no provider, fully unit-testable. The agent-prompts
 * module reads only `kind` to choose the system prompt, so there is no cycle.
 */

import { STARTER_TEMPLATE, STARTER_CONTEXT_FILES } from "@/lib/workbench-starter-template";
import { FULLSTACK_NEXT_FILES, FULLSTACK_NEXT_CONTEXT_FILES } from "@/lib/workbench-template-fullstack";
import { API_NODE_FILES, API_NODE_CONTEXT_FILES } from "@/lib/workbench-template-api";

export type WorkbenchTemplateId = "spa-react" | "fullstack-next" | "api-node";
export type WorkbenchTemplateKind = "spa" | "fullstack" | "api";

export type WorkbenchTemplate = {
  id: WorkbenchTemplateId;
  kind: WorkbenchTemplateKind;
  label: string;
  summary: string;
  /** Scaffold files written into a fresh workspace before the first build. */
  files: Record<string, string>;
  /** Files injected into the agent's project context each turn. */
  contextFiles: readonly string[];
  /** Install command run after scaffolding. */
  installCommand: string;
  /** Commands run after install (e.g. prisma generate / db push). Best-effort. */
  postInstallCommands: readonly string[];
  /** Dev/preview command. */
  devCommand: string;
  /** Port the preview binds to (sandbox proxy exposes this). */
  port: number;
  /** Does this template provision a database? */
  dbKind: "none" | "sqlite";
};

const SPA_TEMPLATE: WorkbenchTemplate = {
  id: "spa-react",
  kind: "spa",
  label: "React SPA",
  summary: "Vite + React 18 + TypeScript + Tailwind + shadcn/ui single-page app.",
  files: STARTER_TEMPLATE,
  contextFiles: STARTER_CONTEXT_FILES,
  installCommand: "npm install --legacy-peer-deps",
  postInstallCommands: [],
  devCommand: "npm run dev",
  port: 3000,
  dbKind: "none",
};

const FULLSTACK_TEMPLATE: WorkbenchTemplate = {
  id: "fullstack-next",
  kind: "fullstack",
  label: "Full-stack Next.js",
  summary: "Next.js 14 App Router + Prisma + SQLite + credentials auth + API routes.",
  files: FULLSTACK_NEXT_FILES,
  contextFiles: FULLSTACK_NEXT_CONTEXT_FILES,
  installCommand: "npm install --legacy-peer-deps",
  // prisma generate runs via postinstall; db push creates the SQLite tables.
  postInstallCommands: ["npx prisma db push --skip-generate --accept-data-loss"],
  devCommand: "npm run dev",
  port: 3000,
  dbKind: "sqlite",
};

const API_TEMPLATE: WorkbenchTemplate = {
  id: "api-node",
  kind: "api",
  label: "Node API service",
  summary: "Hono + @hono/node-server + Prisma + SQLite REST/backend service.",
  files: API_NODE_FILES,
  contextFiles: API_NODE_CONTEXT_FILES,
  installCommand: "npm install --legacy-peer-deps",
  postInstallCommands: ["npx prisma db push --skip-generate --accept-data-loss"],
  devCommand: "npm run dev",
  port: 3000,
  dbKind: "sqlite",
};

const REGISTRY: Record<WorkbenchTemplateId, WorkbenchTemplate> = {
  "spa-react": SPA_TEMPLATE,
  "fullstack-next": FULLSTACK_TEMPLATE,
  "api-node": API_TEMPLATE,
};

export function getWorkbenchTemplate(id: WorkbenchTemplateId): WorkbenchTemplate {
  return REGISTRY[id];
}

export function listWorkbenchTemplates(): WorkbenchTemplate[] {
  return Object.values(REGISTRY);
}

// ── Selection ──────────────────────────────────────────────────────
// Signal-based classifier. Backend/persistence/auth language → fullstack;
// pure-API language → api-node; everything else → SPA. Tuned so the common
// "build me a landing page / todo / dashboard" prompts stay on the fast SPA
// path and only genuine product prompts pull in the DB substrate.

const FULLSTACK_SIGNALS = [
  /\b(saas|web app|webapp|product|platform)\b/,
  /\b(sign[\s-]?up|sign[\s-]?in|log[\s-]?in|login|logout|auth|authentication|account|accounts|register|registration)\b/,
  /\b(users?|multi[\s-]?user|per[\s-]?user|each user|members?|profiles?)\b/,
  /\b(database|persist|persistent|save (?:data|notes?|tasks?|records?|state)|store (?:data|in a database)|crud|records?)\b/,
  /\b(dashboard with (?:data|accounts|login)|admin panel|cms|marketplace|booking|checkout|subscription)\b/,
  /\b(full[\s-]?stack|backend and frontend|frontend and backend|server[\s-]?side)\b/,
];

const API_SIGNALS = [
  /\b(rest api|graphql api|json api|web service|micro[\s-]?service|webhook|endpoint|endpoints)\b/,
  /\b(api server|backend service|backend api|api only|headless)\b/,
];

// Note: "frontend" is deliberately excluded — backend prompts often say
// "no frontend", which must NOT count as a UI signal.
const UI_SIGNALS = /\b(ui|page|screen|landing|website|web app|webapp|dashboard|form|component|design|interface)\b/;

/** Pick the best template id for a build objective. */
export function selectWorkbenchTemplate(objective: string): WorkbenchTemplateId {
  const text = (objective ?? "").toLowerCase();

  const fullstackHit = FULLSTACK_SIGNALS.some((re) => re.test(text));
  const apiHit = API_SIGNALS.some((re) => re.test(text));
  const uiHit = UI_SIGNALS.test(text);

  // Auth/DB/users always implies a server, even if a UI is also requested.
  if (fullstackHit) return "fullstack-next";

  // Pure API with no UI signal → backend-only template.
  if (apiHit && !uiHit) return "api-node";

  // An "API" that also wants a UI is really a full-stack product.
  if (apiHit && uiHit) return "fullstack-next";

  return "spa-react";
}

/** Resolve a template from an explicit id (validated) or by classifying the objective. */
export function resolveWorkbenchTemplate(input: {
  objective: string;
  templateId?: string | null;
}): WorkbenchTemplate {
  const explicit = input.templateId;
  if (explicit && explicit in REGISTRY) {
    return REGISTRY[explicit as WorkbenchTemplateId];
  }
  return REGISTRY[selectWorkbenchTemplate(input.objective)];
}
