import { describe, expect, it } from "vitest";
import {
  getWorkbenchTemplate,
  listWorkbenchTemplates,
  resolveWorkbenchTemplate,
  selectWorkbenchTemplate,
} from "@/lib/workbench-templates";
import { buildSystemPrompt } from "@/lib/workbench-agent-prompts";

describe("selectWorkbenchTemplate", () => {
  it("keeps simple front-end prompts on the fast SPA path", () => {
    expect(selectWorkbenchTemplate("Build a landing page for my coffee shop")).toBe("spa-react");
    expect(selectWorkbenchTemplate("Make a todo list app")).toBe("spa-react");
    expect(selectWorkbenchTemplate("Create a tip calculator")).toBe("spa-react");
    expect(selectWorkbenchTemplate("Build a portfolio website")).toBe("spa-react");
  });

  it("routes auth/DB/multi-user products to the full-stack template", () => {
    expect(selectWorkbenchTemplate("Build a SaaS with email/password login")).toBe("fullstack-next");
    expect(selectWorkbenchTemplate("a habit tracker where each user has private habits that persist")).toBe("fullstack-next");
    expect(selectWorkbenchTemplate("team retro tool with accounts and a database")).toBe("fullstack-next");
    expect(selectWorkbenchTemplate("CRUD app to save records per user")).toBe("fullstack-next");
  });

  it("routes backend-only prompts to the api template", () => {
    expect(selectWorkbenchTemplate("Build a REST API for managing items")).toBe("api-node");
    expect(selectWorkbenchTemplate("Create a webhook handler service")).toBe("api-node");
    expect(selectWorkbenchTemplate("a headless json api, no frontend")).toBe("api-node");
  });

  it("treats API+UI as a full-stack product", () => {
    expect(selectWorkbenchTemplate("a REST API plus a dashboard UI to manage it")).toBe("fullstack-next");
  });
});

describe("resolveWorkbenchTemplate", () => {
  it("honours an explicit valid template id", () => {
    expect(resolveWorkbenchTemplate({ objective: "landing page", templateId: "fullstack-next" }).id).toBe("fullstack-next");
  });
  it("falls back to classification for an unknown id", () => {
    expect(resolveWorkbenchTemplate({ objective: "REST API for items", templateId: "bogus" }).id).toBe("api-node");
    expect(resolveWorkbenchTemplate({ objective: "landing page", templateId: null }).id).toBe("spa-react");
  });
});

describe("template registry shape", () => {
  it("exposes three templates each with install + dev commands and a port", () => {
    const templates = listWorkbenchTemplates();
    expect(templates.map((t) => t.id).sort()).toEqual(["api-node", "fullstack-next", "spa-react"]);
    for (const t of templates) {
      expect(t.installCommand).toMatch(/install/);
      expect(t.devCommand).toBeTruthy();
      expect(t.port).toBe(3000);
      expect(Object.keys(t.files).length).toBeGreaterThan(0);
      const pkg = JSON.parse(t.files["package.json"] ?? "{}") as { scripts?: Record<string, string> };
      expect(pkg.scripts?.dev).toBeTruthy();
      expect(pkg.scripts?.build).toBeTruthy();
      expect(pkg.scripts?.typecheck).toBeTruthy();
    }
  });

  it("full-stack template ships Prisma+SQLite, auth, App Router and runs db push", () => {
    const t = getWorkbenchTemplate("fullstack-next");
    expect(t.dbKind).toBe("sqlite");
    expect(t.postInstallCommands.join(" ")).toMatch(/prisma db push/);
    const schema = t.files["prisma/schema.prisma"] ?? "";
    expect(schema).toContain('provider = "sqlite"');
    expect(schema).toContain("model User");
    expect(schema).toContain("model Session");
    expect(t.files["src/lib/auth.ts"]).toContain("createSession");
    expect(t.files["src/app/layout.tsx"]).toBeTruthy();
    expect(t.files["src/app/api/health/route.ts"]).toContain("force-dynamic");
    // No Vite leakage in the full-stack template.
    expect(t.files["vite.config.ts"]).toBeUndefined();
  });

  it("api template ships Hono + a passing route test", () => {
    const t = getWorkbenchTemplate("api-node");
    expect(t.dbKind).toBe("sqlite");
    expect(t.files["src/app.ts"]).toContain("new Hono()");
    expect(t.files["src/app.test.ts"]).toContain("app.request");
    const pkg = JSON.parse(t.files["package.json"] ?? "{}") as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.hono).toBeTruthy();
  });
});

describe("buildSystemPrompt is template-aware", () => {
  it("SPA prompt forbids Next.js", () => {
    const spa = buildSystemPrompt("spa");
    expect(spa).toMatch(/NOT Next\.js/);
    expect(spa).toMatch(/Vite \+ React/);
  });
  it("full-stack prompt teaches Next.js App Router + Prisma + auth", () => {
    const fs = buildSystemPrompt("fullstack");
    expect(fs).toMatch(/App Router/);
    expect(fs).toMatch(/Prisma/);
    expect(fs).toMatch(/getSessionUser/);
    expect(fs).not.toMatch(/NOT Next\.js/);
  });
  it("api prompt teaches Hono and forbids a UI", () => {
    const api = buildSystemPrompt("api");
    expect(api).toMatch(/Hono/);
    expect(api).toMatch(/This is an API/);
  });
  it("defaults to the SPA prompt", () => {
    expect(buildSystemPrompt()).toBe(buildSystemPrompt("spa"));
  });
});
