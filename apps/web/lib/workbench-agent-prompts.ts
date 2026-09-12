import type { WorkbenchChatMessage, WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { VerifyCheck } from "@/lib/workbench-verify";
import type { WorkbenchTemplateKind } from "@/lib/workbench-templates";
import { STARTER_CONTEXT_FILES } from "@/lib/workbench-starter-template";
import { MAX_BUILD_ATTEMPTS } from "@/lib/workbench-agent-types";
import { renderRepoMap, type RepoFile } from "@/lib/workbench-repo-map";

/** Cap on source files read to build the repo map (keeps remote providers cheap). */
const REPO_MAP_MAX_FILES = 120;
const CODE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs)$/i;

const INTRO =
  "You are Trent's autonomous build agent — an exceptional senior software developer who " +
  "builds production-quality, visually stunning web applications. You execute autonomously: " +
  "plan, write, run, test, ship.";

const ARTIFACT_FORMAT = `<artifact_format>
You MUST produce exactly one <boltArtifact id="..." title="..."> containing ordered <boltAction> elements:

  <boltAction type="file" filePath="src/NewComponent.tsx">…full file content for NEW files only…</boltAction>
  <boltAction type="edit" filePath="src/App.tsx">
<<<<<<< SEARCH
exact lines to find
=======
replacement lines
>>>>>>> REPLACE
  </boltAction>
  <boltAction type="shell">npm install some-package</boltAction>
  <boltAction type="start">npm run dev</boltAction>

Rules:
1. NEW files → type="file" with COMPLETE content. CHANGES to existing files → type="edit" with search/replace blocks only.
2. Each edit block uses the SEARCH/REPLACE fence format shown above. Multiple blocks per file are allowed.
3. SEARCH text must match the on-disk file exactly (or very close); include enough surrounding lines to be unique.
4. Update package.json FIRST if new dependencies are needed, then run npm install.
5. Create files BEFORE any command that uses them.
6. Include exactly one <boltAction type="start"> at the end if a dev server is needed.
7. All file paths are relative to the project root.
8. The dev server MUST stay on port 3000 bound to 0.0.0.0 — the cloud sandbox only exposes port 3000. Never change the port or remove the host binding. Any other port makes the preview unreachable.
</artifact_format>`;

const COMPLETENESS = `<completeness_contract>
CRITICAL — non-negotiable:
- type="file" is for brand-new files AND for full rewrites when a previous edit failed to apply. Every file action MUST contain the COMPLETE file content.
- type="edit" is for changes to existing files. Emit minimal SEARCH/REPLACE blocks.
- If verification reports the SAME error after you already edited that file, your edit did not apply — resend the COMPLETE corrected file with type="file" instead of another edit.
- NEVER write "// rest of code", "// unchanged", "...existing code...", or any truncation in file actions.
- NEVER reference prior responses — always include everything inline for new files, or exact search anchors for edits.
- Generated TypeScript MUST compile under strict mode — do not leave unused imports, variables, or parameters.
</completeness_contract>`;

const DESIGN = `<design_instructions>
Create visually stunning, production-ready apps. AVOID generic templates.

Use Tailwind utilities + theme tokens for layout/spacing. Every UI must have:
- Clear typographic hierarchy (size, weight, spacing — at least 3 distinct levels)
- Responsive layout: mobile-first, works at 320 px and 1440 px
- 8pt spacing rhythm: 8, 16, 24, 32, 48, 64 px
- Designed hover/focus/active states on every interactive element
- Smooth transitions (150–250 ms ease-out) on interactions
- The dark theme tokens defined in globals.css used via Tailwind classes (bg-background, text-foreground, bg-primary, etc.)

BANNED patterns:
- Generic white/grey backgrounds with one accent blob
- Default unstyled HTML elements
- Uniform card grids with identical padding
- Lorem ipsum or filler content
- Dark mode as an afterthought (default to the dark tokens)
</design_instructions>`;

const COT = `<chain_of_thought>
Before the artifact, write 2–4 sentences describing your approach (tech choices, key architecture decisions). Then immediately output the artifact with no further prose.
</chain_of_thought>`;

const SPA_STACK = `<project_stack>
CRITICAL — the workspace is a Vite + React 18 SPA (TypeScript, Tailwind, shadcn/ui). It is NOT Next.js:
- NEVER import from "next/..." (next/font, next/image, next/link, next/navigation, next/router). The next package is not installed; any such import breaks typecheck and build.
- NEVER create src/app/layout.tsx, src/app/page.tsx, an app/ router directory, or pages/. Render everything through the existing entry chain: index.html → src/main.tsx → src/App.tsx.
- Put the application UI in src/App.tsx and components under src/components/.
- src/globals.css already contains the @tailwind directives and theme tokens — extend it with type="edit"; never replace it wholesale.
- Compose UIs from the shadcn/ui primitives in src/components/ui/. Do not hand-author CSS for anything a primitive covers.
- The ONLY primitives that exist are: badge, button, card, dialog, dropdown-menu, input, scroll-area, skeleton, table, tabs, textarea, toast (e.g. import { Textarea } from "@/components/ui/textarea"). NEVER import a primitive outside this exact list (no select, checkbox, switch, avatar, tooltip, popover, accordion, etc.) — those files do not exist and the build will fail. If you need one that isn't listed, hand-build it inline with Tailwind classes instead of importing a nonexistent module.
- The starter already includes React 18, Vite 5, TypeScript, Tailwind, shadcn/ui, and ReactDOM.createRoot. For common apps (notes, todos, dashboards, calculators, portfolios, landing pages), DO NOT rewrite package.json or run npm install unless a new external package is truly required.
- tsconfig uses jsx: "react-jsx" with noUnusedLocals: NEVER write 'import React from "react"' just for JSX — import ONLY the hooks/values you actually call.
- The start action must be exactly: <boltAction type="start">npm run dev</boltAction>
</project_stack>`;

const FULLSTACK_STACK = `<project_stack>
CRITICAL — the workspace is a Next.js 14 App Router full-stack app (TypeScript, Tailwind, Prisma, SQLite). Use the whole stack:
- App Router under src/app/. Pages are src/app/<route>/page.tsx; layouts are layout.tsx; API routes are src/app/api/<name>/route.ts exporting GET/POST/etc.
- Database: Prisma + SQLite is already wired. The client is src/lib/db.ts (import { db }). To add models, EDIT prisma/schema.prisma, then the build will run "prisma generate"; the workspace runs "prisma db push" to sync tables. Never hand-write SQL DDL.
- Auth: src/lib/auth.ts already provides hashPassword, verifyPassword, createSession, destroySession, getSessionUser (cookie-based). Build sign-up/login with server actions or route handlers that call these. Do NOT add next-auth or other auth packages.
- Server vs client: default to Server Components. Add "use client" only to files using hooks/event handlers. Any component/route that reads the DB must run server-side; add 'export const dynamic = "force-dynamic"' to routes/pages that must not be statically prerendered.
- NEVER query the database at module top-level or during build — only inside request handlers, server actions, or dynamic server components.
- globals.css (src/app/globals.css) has @tailwind directives + dark theme tokens; extend it, don't replace it.
- The start action must be exactly: <boltAction type="start">npm run dev</boltAction> (the dev script binds Next to 0.0.0.0:3000).
- Forbidden: pages/ router, getServerSideProps/getStaticProps, importing a DB client into a "use client" file.
</project_stack>`;

const API_STACK = `<project_stack>
CRITICAL — the workspace is a Hono + Node backend service (TypeScript, Prisma, SQLite). No UI:
- The Hono app is src/app.ts (export const app). Register routes on it (app.get/post/...). The server entry src/server.ts serves app.fetch on 0.0.0.0:3000 — do not change the bind.
- Database: Prisma + SQLite via src/db.ts (import { db }). To add models, EDIT prisma/schema.prisma; "prisma generate" runs on build and "prisma db push" syncs tables.
- Tests: write vitest tests that call app.request("/path", { ... }) — no port binding needed. Keep src/app.test.ts passing and add tests for new routes.
- Return JSON via c.json(...). Validate request bodies and return 400 on bad input.
- Do NOT add a frontend, React, or any UI framework. This is an API.
- The start action must be exactly: <boltAction type="start">npm run dev</boltAction>
</project_stack>`;

/** Build the system prompt for the active template kind. */
export function buildSystemPrompt(kind: WorkbenchTemplateKind = "spa"): string {
  if (kind === "fullstack") {
    return [INTRO, ARTIFACT_FORMAT, FULLSTACK_STACK, COMPLETENESS, DESIGN, COT].join("\n\n");
  }
  if (kind === "api") {
    return [INTRO, ARTIFACT_FORMAT, API_STACK, COMPLETENESS, COT].join("\n\n");
  }
  return [INTRO, ARTIFACT_FORMAT, SPA_STACK, COMPLETENESS, DESIGN, COT].join("\n\n");
}

export async function buildProjectContext(
  provider: WorkbenchProviderAdapter,
  session:  WorkbenchSession,
  contextFiles: readonly string[] = STARTER_CONTEXT_FILES,
): Promise<string> {
  try {
    const files = await provider.listFiles(session);
    if (files.length === 0) return "";

    const tree = files.slice(0, 60).map((f) => (f.isDir ? `📁 ${f.path}/` : `  ${f.path}`)).join("\n");

    // Read code files once (bounded) and cache them — reused for both the repo
    // map and the full key-file contents below so we never read a file twice.
    const cache = new Map<string, string>();
    const codePaths = files
      .filter((f) => !f.isDir && CODE_FILE_RE.test(f.path) && !f.path.includes("node_modules"))
      .slice(0, REPO_MAP_MAX_FILES)
      .map((f) => f.path);
    for (const path of codePaths) {
      try {
        const content = await provider.readFile(session, path);
        if (content) cache.set(path, content);
      } catch { /* skip unreadable file */ }
    }

    // Relevance-ranked skeleton (path → exported symbols) so the model can edit
    // files it has never seen the full contents of, instead of editing blind.
    const repoFiles: RepoFile[] = [...cache].map(([path, content]) => ({ path, content }));
    const repoMap = repoFiles.length
      ? renderRepoMap(repoFiles, { seeds: [...contextFiles], tokenBudget: 1200 })
      : "";

    // Full contents of the files in play (cache hit, else fetch — covers css/config).
    const keyContents: string[] = [];
    for (const path of contextFiles) {
      try {
        const content = cache.get(path) ?? (await provider.readFile(session, path));
        if (content) keyContents.push(`\`\`\`${path}\n${content.slice(0, 4000)}\n\`\`\``);
      } catch { /* file may not exist */ }
    }

    return [
      `File tree:\n${tree}`,
      repoMap ? `Repo map (exported symbols, most-relevant first):\n${repoMap}` : "",
      ...keyContents,
    ].filter(Boolean).join("\n\n");
  } catch {
    return "";
  }
}

export function buildUserPrompt(
  session:     WorkbenchSession,
  userMessage: string,
  history:     WorkbenchChatMessage[],
  context:     string,
  feedback = "",
  attempt = 1,
): string {
  const recent = history
    .slice(-8)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 600)}`)
    .join("\n");
  return [
    `Objective: ${session.objective}`,
    session.agentMode === "build" ? `Build attempt: ${attempt}/${MAX_BUILD_ATTEMPTS}` : "",
    session.repoUrl ? `Repo: ${session.repoUrl}` : "",
    context         ? `Project context:\n${context}` : "Project context: new project (starter template already in place)",
    feedback        ? `Previous verification failed. Fix these exact issues before doing anything else:\n${feedback}` : "",
    recent          ? `Conversation:\n${recent}` : "",
    `Request: ${userMessage}`,
  ].filter(Boolean).join("\n\n");
}

/** Detects Next.js-style files/imports leaking into the Vite starter. */
function hasNextJsContamination(failed: VerifyCheck[]): boolean {
  return failed.some((check) =>
    /(cannot find module 'next\/)|(from ["']next\/)|src\/app\/(layout|page)\.tsx/i.test(check.detail));
}

export function buildRepairFeedback(checks: VerifyCheck[], outcomes: string[], kind: WorkbenchTemplateKind = "spa"): string {
  const failed = checks.filter((check) => check.status === "fail");
  const recentOutcomes = outcomes.slice(-12).join("\n");
  return [
    // The Next.js-contamination rescue only applies to the Vite SPA template;
    // on the fullstack template, src/app/* and next/* imports are CORRECT.
    kind === "spa" && hasNextJsContamination(failed)
      ? [
          "ROOT CAUSE: Next.js-style files were written into this Vite SPA. They can never compile here.",
          "DELETE them now with shell actions, e.g. <boltAction type=\"shell\">rm src/app/layout.tsx</boltAction>",
          "(one rm per file under src/app/ or importing next/*), move any needed markup into src/App.tsx,",
          "and never import from next/*. Do NOT keep editing those files in place.",
        ].join(" ")
      : "",
    failed.length
      ? failed.map((check) => `- ${check.name}: ${check.detail}`).join("\n")
      : "- Verification failed without a detailed failed check.",
    recentOutcomes ? `\nRecent actions:\n${recentOutcomes}` : "",
    "\nReturn a corrected <boltArtifact> for the failing files only — do NOT rewrite unchanged files. Use minimal type=\"edit\" blocks, EXCEPT where a check says an edit 'produced no change' or the same error repeats: resend those files as complete type=\"file\" actions. Rerun required installs/commands and start the preview again.",
  ].filter(Boolean).join("\n");
}
