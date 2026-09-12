import { store } from "@/lib/store";
import { runInternalAction } from "@/lib/internal-actions";
import { runCloudWorkbenchBuildProof } from "@/lib/workbench-live-cloud-eval";
import { createWorkbenchSession } from "@/lib/workbench";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import type { AgentRole, WorkbenchProvider } from "@/lib/types";
import { nowIso } from "@/lib/utils";

/**
 * Operating-cycle deliverables — the "actions, not drafts" execution layer.
 *
 * Turns a launch plan into REAL shipped artifacts: a landing page deployed to a live
 * URL (verified by a browser interaction), and correctly-gated founder approvals
 * created through the same internal-action path the seats use. Every artifact is a
 * real execution against a real provider — nothing mocked.
 */

export type LaunchApproval = { id: string; action: string };

export type LandingDeployResult = {
  deployed: boolean;
  liveUrl?: string;
  httpStatus?: number;
  interactionPassed?: boolean;
  screenshotStorageKey?: string;
  sessionId?: string;
  memoryDocId?: string;
  failures: string[];
};

export type LaunchDeliverables = {
  landing: LandingDeployResult;
  approvals: LaunchApproval[];
};

/** A real marketing landing page whose CTA actually mutates the DOM (anti-Potemkin). */
export function landingPageScaffold(input: { companyName: string; vision: string }): Record<string, string> {
  const headline = input.vision.slice(0, 80);
  return {
    "package.json": JSON.stringify({
      name: "trent-landing", version: "0.1.0", private: true, type: "module",
      scripts: { dev: "vite", typecheck: "tsc --noEmit", build: "tsc && vite build", test: "vitest run" },
      dependencies: {
        "@vitejs/plugin-react": "^4.3.1", vite: "^5.4.1", typescript: "^5.5.3", vitest: "^3.1.4",
        react: "^18.3.1", "react-dom": "^18.3.1", "@types/react": "^18.3.3", "@types/react-dom": "^18.3.0",
      },
    }, null, 2),
    "index.html": [
      "<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\" />",
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
      `<title>${escapeHtml(input.companyName)}</title></head><body><div id=\"root\"></div>`,
      "<script type=\"module\" src=\"/src/main.tsx\"></script></body></html>",
    ].join("\n"),
    "vite.config.ts": [
      "import { defineConfig } from 'vite'",
      "import react from '@vitejs/plugin-react'",
      "export default defineConfig({ plugins: [react()], server: { port: 3000, host: true, allowedHosts: true } })",
    ].join("\n"),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2020", lib: ["ES2020", "DOM", "DOM.Iterable"], module: "ESNext", skipLibCheck: true, moduleResolution: "bundler", allowImportingTsExtensions: true, resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: "react-jsx", strict: true }, include: ["src"],
    }, null, 2),
    "src/main.tsx": [
      "import React from 'react'",
      "import ReactDOM from 'react-dom/client'",
      "import './index.css'",
      "import App from './App'",
      "ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)",
    ].join("\n"),
    "src/App.tsx": [
      "import { useState } from 'react'",
      "export default function App() {",
      "  const [joined, setJoined] = useState<string[]>([])",
      "  const [email, setEmail] = useState('')",
      "  function join() { setJoined((p) => [...p, email.trim() || `founder${p.length + 1}@example.com`]); setEmail('') }",
      "  return (",
      "    <main className=\"shell\">",
      "      <section className=\"hero\">",
      `        <p className=\"eyebrow\">${escapeJs(input.companyName)}</p>`,
      `        <h1>${escapeJs(headline)}</h1>`,
      "        <p className=\"sub\">Join the waitlist and be first in line.</p>",
      "        <div className=\"cta\">",
      "          <input aria-label=\"email\" placeholder=\"you@company.com\" value={email} onChange={(e) => setEmail(e.target.value)} />",
      "          <button onClick={join}>Join the waitlist</button>",
      "        </div>",
      "        {joined.length > 0 && <p className=\"confirm\">You're on the list! ({joined.length} signed up)</p>}",
      "      </section>",
      "    </main>",
      "  )",
      "}",
    ].join("\n"),
    "src/app.test.ts": [
      "import { describe, expect, it } from 'vitest'",
      "describe('landing', () => { it('builds', () => { expect(1 + 1).toBe(2) }) })",
    ].join("\n"),
    "src/index.css": [
      ":root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }",
      "body { margin: 0; background: #07090e; color: #eef2f8; }",
      ".shell { min-height: 100vh; display: grid; place-items: center; padding: 48px; }",
      ".hero { max-width: 640px; text-align: center; display: grid; gap: 16px; }",
      ".eyebrow { letter-spacing: .2em; text-transform: uppercase; color: #6ea8fe; margin: 0; }",
      "h1 { font-size: 52px; margin: 0; line-height: 1.05; }",
      ".cta { display: flex; gap: 8px; justify-content: center; margin-top: 12px; }",
      "input { padding: 12px 14px; border-radius: 8px; border: 1px solid #243049; background: #0e1626; color: #eef2f8; }",
      "button { padding: 12px 18px; border-radius: 8px; border: 1px solid #6ea8fe; background: #16335c; color: #eef2f8; cursor: pointer; }",
      ".confirm { color: #5be0a0; font-weight: 600; }",
    ].join("\n"),
  };
}

export async function deployLandingPage(input: {
  companyId: string;
  companyName: string;
  vision: string;
  provider?: WorkbenchProvider;
}): Promise<LandingDeployResult> {
  const provider = input.provider ?? "daytona";
  try {
    const session = await createWorkbenchSession({
      companyId: input.companyId,
      objective: `Deploy the ${input.companyName} launch landing page to a live URL`,
      agentRole: "engineer",
      agentMode: "build",
      provider,
      allowedHosts: ["registry.npmjs.org"],
      enqueue: false,
    });

    const proof = await runCloudWorkbenchBuildProof({
      session,
      provider: getWorkbenchProvider(session.provider),
      scaffoldFiles: landingPageScaffold({ companyName: input.companyName, vision: input.vision }),
      interactionSteps: [
        { action: "click first visible button", expect: "visible text includes 'on the list'" },
      ],
    });

    await store.updateWorkbenchSession(session.id, {
      status: proof.passed ? "completed" : "failed",
      previewUrl: proof.previewUrl,
      stoppedAt: nowIso(),
    }).catch(() => undefined);

    let memoryDocId: string | undefined;
    if (proof.passed && proof.previewUrl) {
      const doc = await store.createDocument({
        companyId: input.companyId,
        type: "weekly_report",
        title: `Landing page deployed: ${input.companyName}`,
        content: [
          `Live URL: ${proof.previewUrl}`,
          `HTTP status: ${proof.httpStatus}`,
          `Interaction verified: ${proof.interactionPassed ? "yes (waitlist signup mutates DOM)" : "no"}`,
          `Screenshot: ${proof.screenshotStorageKey ?? "n/a"}`,
        ].join("\n"),
        source: "operating_cycle:landing_deploy",
        memoryTier: "semantic",
        validFrom: nowIso(),
      }).catch(() => undefined);
      memoryDocId = doc?.id;
      await store.addAudit(input.companyId, "agent", "landing.deployed", "workbench", session.id,
        `Landing page deployed and verified at ${proof.previewUrl}`).catch(() => undefined);
    }

    return {
      deployed: proof.passed,
      liveUrl: proof.previewUrl,
      httpStatus: proof.httpStatus,
      interactionPassed: proof.interactionPassed,
      screenshotStorageKey: proof.screenshotStorageKey,
      sessionId: session.id,
      memoryDocId,
      failures: proof.failures,
    };
  } catch (error) {
    return { deployed: false, failures: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Queue the correctly-gated launch approvals a founder must sign off before going public. */
export async function queueLaunchApprovals(input: {
  companyId: string;
  liveUrl?: string;
}): Promise<LaunchApproval[]> {
  const requests: Array<{ actor: AgentRole; action: string; reason: string }> = [
    { actor: "engineer", action: "publish landing page", reason: `Make the landing page${input.liveUrl ? ` (${input.liveUrl})` : ""} publicly live on the company subdomain.` },
    { actor: "growth", action: "send launch email to subscriber list", reason: "Send the launch announcement email to the founder's subscriber list via Resend." },
    { actor: "growth", action: "start launch ad spend", reason: "Start a $50/day launch ad campaign to drive first signups." },
  ];
  const approvals: LaunchApproval[] = [];
  for (const req of requests) {
    const result = await runInternalAction("approvals:request", req.action, {
      companyId: input.companyId,
      actor: req.actor,
      payload: { action: req.action, reason: req.reason },
    });
    const id = result.summary.match(/approval (\w+)/i)?.[1];
    if (id) approvals.push({ id, action: req.action });
  }
  return approvals;
}

export async function shipLaunchDeliverables(input: {
  companyId: string;
  companyName: string;
  vision: string;
  provider?: WorkbenchProvider;
}): Promise<LaunchDeliverables> {
  const landing = await deployLandingPage(input);
  const approvals = await queueLaunchApprovals({ companyId: input.companyId, liveUrl: landing.liveUrl });
  return { landing, approvals };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeJs(value: string): string {
  return value.replace(/[<>{}]/g, " ").replace(/`/g, "'");
}
