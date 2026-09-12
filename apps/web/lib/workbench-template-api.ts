/**
 * workbench-template-api.ts
 *
 * Backend-only starter: Hono + @hono/node-server + Prisma + SQLite. For prompts
 * that ask for a REST API / webhook handler / backend service with no UI. Hono's
 * `app.request()` lets the verifier run real route tests without binding a port,
 * and `@hono/node-server` serves on 0.0.0.0:3000 for the live preview.
 */

const PACKAGE_JSON = JSON.stringify(
  {
    name: "trent-api-service",
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "tsx watch src/server.ts",
      build: "prisma generate && tsc",
      start: "node dist/server.js",
      typecheck: "tsc --noEmit",
      test: "vitest run",
      "db:push": "prisma db push --skip-generate",
      postinstall: "prisma generate",
    },
    dependencies: {
      hono: "^4.6.5",
      "@hono/node-server": "^1.13.2",
      "@prisma/client": "^5.22.0",
    },
    devDependencies: {
      "@types/node": "^20.16.0",
      prisma: "^5.22.0",
      tsx: "^4.19.1",
      typescript: "^5.5.3",
      vitest: "^2.1.3",
    },
  },
  null,
  2,
);

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022"],
      outDir: "dist",
      rootDir: "src",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      types: ["node"],
      paths: { "@/*": ["./src/*"] },
      baseUrl: ".",
    },
    include: ["src"],
    exclude: ["node_modules", "dist"],
  },
  null,
  2,
);

const ENV_FILE = `DATABASE_URL="file:./dev.db"
PORT=3000
`;

const GITIGNORE = `node_modules
dist
dev.db
dev.db-journal
*.log
`;

const PRISMA_SCHEMA = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Item {
  id        String   @id @default(cuid())
  title     String
  done      Boolean  @default(false)
  createdAt DateTime @default(now())
}
`;

const DB_TS = `import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
`;

const APP_TS = `import { Hono } from "hono";
import { db } from "./db.js";

// The Hono app is exported separately from the server so tests can call
// app.request() without binding a port.
export const app = new Hono();

app.get("/", (c) => c.json({ ok: true, service: "trent-api" }));

app.get("/api/health", (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.get("/api/items", async (c) => {
  const items = await db.item.findMany({ orderBy: { createdAt: "desc" } });
  return c.json({ items });
});

app.post("/api/items", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return c.json({ error: "title is required" }, 400);
  }
  const item = await db.item.create({ data: { title: body.title.trim() } });
  return c.json({ item }, 201);
});
`;

const SERVER_TS = `import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, hostname: "0.0.0.0", port });
console.log(\`API listening on http://0.0.0.0:\${port}\`);
`;

const APP_TEST = `import { describe, expect, it } from "vitest";
import { app } from "./app.js";

describe("api", () => {
  it("health endpoint responds ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("rejects items without a title", async () => {
    const res = await app.request("/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
`;

export const API_NODE_FILES: Record<string, string> = {
  "package.json": PACKAGE_JSON,
  "tsconfig.json": TSCONFIG,
  ".env": ENV_FILE,
  ".gitignore": GITIGNORE,
  "prisma/schema.prisma": PRISMA_SCHEMA,
  "src/db.ts": DB_TS,
  "src/app.ts": APP_TS,
  "src/server.ts": SERVER_TS,
  "src/app.test.ts": APP_TEST,
};

export const API_NODE_CONTEXT_FILES = [
  "prisma/schema.prisma",
  "src/app.ts",
  "src/db.ts",
] as const;
