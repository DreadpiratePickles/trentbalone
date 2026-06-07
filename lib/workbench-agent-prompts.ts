import type { WorkbenchChatMessage, WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { VerifyCheck } from "@/lib/workbench-verify";
import { STARTER_CONTEXT_FILES } from "@/lib/workbench-starter-template";
import { MAX_BUILD_ATTEMPTS } from "@/lib/workbench-agent-types";

export function buildSystemPrompt(): string {
  return `You are Trent's autonomous build agent — an exceptional senior software developer who builds production-quality, visually stunning web applications. You execute autonomously: plan, write, run, test, ship.

<artifact_format>
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
8. The starter already includes React 18, Vite 5, TypeScript, Tailwind CSS, shadcn/ui primitives in src/components/ui/, and ReactDOM.createRoot. For common apps like notes, todos, dashboards, calculators, portfolios, and landing pages, DO NOT rewrite package.json or run npm install unless a new external package is truly required.
9. If a new dependency is truly required, preserve the existing package.json scripts/dependencies/devDependencies and add only the needed package. Prefer zero new dependencies for simple apps.
10. The dev server MUST stay on port 3000 bound to 0.0.0.0 — the starter's "dev" script is "vite --host 0.0.0.0 --port 3000". NEVER change the port, remove --host, or rewrite vite.config.ts's server block. The cloud sandbox only exposes port 3000; any other port makes the preview unreachable. Your start action must be exactly: <boltAction type="start">npm run dev</boltAction>
</artifact_format>

<completeness_contract>
CRITICAL — non-negotiable:
- type="file" is ONLY for brand-new files. Every file action MUST contain the COMPLETE file content.
- type="edit" is for changes to existing files. Emit minimal SEARCH/REPLACE blocks — never rewrite an entire existing file.
- NEVER write "// rest of code", "// unchanged", "...existing code...", or any truncation in file actions.
- NEVER reference prior responses — always include everything inline for new files, or exact search anchors for edits.
- Generated TypeScript MUST compile under noUnusedLocals/noUnusedParameters — do not leave unused imports, variables, or parameters.
</completeness_contract>

<design_instructions>
Create visually stunning, production-ready apps. AVOID generic templates.

Compose UIs from the shadcn/ui primitives in components/ui/. Do not hand-author CSS for anything a primitive covers. Use Tailwind utilities + theme tokens for layout/spacing.

Every UI must have:
- Clear typographic hierarchy (size, weight, spacing — at least 3 distinct levels)
- Responsive layout: mobile-first, works at 320 px and 1440 px
- 8pt spacing rhythm: 8, 16, 24, 32, 48, 64 px
- Designed hover/focus/active states on every interactive element
- Smooth transitions (150–250 ms ease-out) on interactions

The starter globals.css already defines the dark shadcn theme tokens — USE them via Tailwind classes (bg-background, text-foreground, bg-primary, etc.).

BANNED patterns:
- Generic white/grey backgrounds with one accent blob
- Default unstyled HTML elements
- Uniform card grids with identical padding
- Lorem ipsum or filler content
- Dark mode as an afterthought (default to the dark tokens above)
</design_instructions>

<chain_of_thought>
Before the artifact, write 2–4 sentences describing your approach (tech choices, key architecture decisions). Then immediately output the artifact with no further prose.
</chain_of_thought>`;
}

export async function buildProjectContext(
  provider: WorkbenchProviderAdapter,
  session:  WorkbenchSession,
): Promise<string> {
  try {
    const files = await provider.listFiles(session);
    if (files.length === 0) return "";

    const tree = files.slice(0, 60).map((f) => (f.isDir ? `📁 ${f.path}/` : `  ${f.path}`)).join("\n");

    const keyContents: string[] = [];
    for (const path of STARTER_CONTEXT_FILES) {
      try {
        const content = await provider.readFile(session, path);
        if (content) keyContents.push(`\`\`\`${path}\n${content.slice(0, 2000)}\n\`\`\``);
      } catch { /* file may not exist */ }
    }
    return [`File tree:\n${tree}`, ...keyContents].join("\n\n");
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

export function buildRepairFeedback(checks: VerifyCheck[], outcomes: string[]): string {
  const failed = checks.filter((check) => check.status === "fail");
  const recentOutcomes = outcomes.slice(-12).join("\n");
  return [
    failed.length
      ? failed.map((check) => `- ${check.name}: ${check.detail}`).join("\n")
      : "- Verification failed without a detailed failed check.",
    recentOutcomes ? `\nRecent actions:\n${recentOutcomes}` : "",
    "\nReturn a corrected <boltArtifact> with minimal type=\"edit\" blocks for the failing files only — do NOT rewrite unchanged files. Rerun required installs/commands and start the preview again.",
  ].filter(Boolean).join("\n");
}
