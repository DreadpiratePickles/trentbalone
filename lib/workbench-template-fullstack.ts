/**
 * workbench-template-fullstack.ts
 *
 * Full-stack starter: Next.js 14 (App Router) + TypeScript + Tailwind +
 * Prisma + SQLite + a dependency-light credentials-auth library. This is the
 * substrate that lets a one-line prompt produce a real product (auth + DB +
 * API + UI), not a static SPA. The agent edits this baseline; it must install,
 * `prisma db push`, typecheck, `next build`, and `next dev` cleanly as-is.
 */

const PACKAGE_JSON = JSON.stringify(
  {
    name: "trent-fullstack-app",
    version: "0.1.0",
    private: true,
    scripts: {
      // Bind dev to 0.0.0.0:3000 — the cloud sandbox proxy only exposes 3000.
      dev: "next dev -H 0.0.0.0 -p 3000",
      build: "prisma generate && next build",
      start: "next start -H 0.0.0.0 -p 3000",
      typecheck: "tsc --noEmit",
      "db:push": "prisma db push --skip-generate",
      postinstall: "prisma generate",
    },
    dependencies: {
      next: "14.2.15",
      react: "^18.3.1",
      "react-dom": "^18.3.1",
      "@prisma/client": "^5.22.0",
    },
    devDependencies: {
      "@types/node": "^20.16.0",
      "@types/react": "^18.3.3",
      "@types/react-dom": "^18.3.0",
      autoprefixer: "^10.4.20",
      postcss: "^8.4.47",
      prisma: "^5.22.0",
      tailwindcss: "^3.4.14",
      typescript: "^5.5.3",
    },
  },
  null,
  2,
);

const NEXT_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Sandbox previews are proxied through arbitrary hosts; allow them.
  experimental: { },
};

export default nextConfig;
`;

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2021",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: false,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      plugins: [{ name: "next" }],
      paths: { "@/*": ["./src/*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2,
);

const NEXT_ENV_DTS = `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;

const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

const TAILWIND_CONFIG = `import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: "hsl(var(--card))",
        primary: "hsl(var(--primary))",
        "primary-foreground": "hsl(var(--primary-foreground))",
        muted: "hsl(var(--muted))",
        "muted-foreground": "hsl(var(--muted-foreground))",
        border: "hsl(var(--border))",
      },
    },
  },
  plugins: [],
} satisfies Config;
`;

const ENV_FILE = `# SQLite runs anywhere with zero setup — perfect for sandbox builds.
DATABASE_URL="file:./dev.db"
# Session-cookie signing secret. Override in production.
AUTH_SECRET="dev-insecure-change-me"
`;

const GITIGNORE = `node_modules
.next
dev.db
dev.db-journal
*.log
.env.local
`;

const PRISMA_SCHEMA = `// SQLite keeps the whole DB in one file — no server, runs in any sandbox.
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model User {
  id           String    @id @default(cuid())
  email        String    @unique
  passwordHash String
  createdAt    DateTime  @default(now())
  sessions     Session[]
}

model Session {
  id        String   @id @default(cuid())
  token     String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime @default(now())
}
`;

const DB_TS = `import { PrismaClient } from "@prisma/client";

// Reuse one PrismaClient across hot-reloads / serverless invocations.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
`;

const AUTH_TS = `import { cookies } from "next/headers";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

const SESSION_COOKIE = "trent_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/** Hash a password with scrypt (salt embedded). No external dependency. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return \`\${salt}:\${derived}\`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const derived = scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(key, "hex");
  return keyBuffer.length === derived.length && timingSafeEqual(keyBuffer, derived);
}

/** Create a session row + set the httpOnly cookie. Call from a server action / route. */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({ data: { token, userId, expiresAt } });
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { token } });
  cookies().delete(SESSION_COOKIE);
}

/** Returns the signed-in user or null. Use in server components / route handlers. */
export async function getSessionUser() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({ where: { token }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}
`;

const LAYOUT_TSX = `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trent App",
  description: "Built with the Trent full-stack workbench",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
`;

const GLOBALS_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 220 33% 4%;
    --foreground: 214 33% 93%;
    --card: 220 30% 7%;
    --primary: 213 93% 68%;
    --primary-foreground: 220 33% 4%;
    --muted: 220 26% 16%;
    --muted-foreground: 213 18% 65%;
    --border: 220 24% 17%;
  }
  body {
    background: hsl(var(--background));
    color: hsl(var(--foreground));
    font-family: system-ui, -apple-system, sans-serif;
    min-height: 100vh;
  }
}
`;

const PAGE_TSX = `export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8 text-center">
      <p className="text-sm uppercase tracking-widest text-muted-foreground">Trent full-stack starter</p>
      <h1 className="text-5xl font-bold">Ready to build</h1>
      <p className="max-w-md text-muted-foreground">
        Next.js App Router + Prisma + SQLite + credentials auth are wired and ready.
        Build pages in <code>src/app</code>, APIs in <code>src/app/api</code>, and use{" "}
        <code>@/lib/auth</code> for sign-up / login.
      </p>
      <a
        href="/api/health"
        className="rounded-md border border-border bg-card px-4 py-2 text-primary"
      >
        Check API health
      </a>
    </main>
  );
}
`;

const HEALTH_ROUTE = `import { NextResponse } from "next/server";

// Backend smoke endpoint — the verifier hits this to confirm the server runs.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, service: "trent-fullstack", time: new Date().toISOString() });
}
`;

export const FULLSTACK_NEXT_FILES: Record<string, string> = {
  "package.json": PACKAGE_JSON,
  "next.config.mjs": NEXT_CONFIG,
  "tsconfig.json": TSCONFIG,
  "next-env.d.ts": NEXT_ENV_DTS,
  "postcss.config.mjs": POSTCSS_CONFIG,
  "tailwind.config.ts": TAILWIND_CONFIG,
  ".env": ENV_FILE,
  ".gitignore": GITIGNORE,
  "prisma/schema.prisma": PRISMA_SCHEMA,
  "src/lib/db.ts": DB_TS,
  "src/lib/auth.ts": AUTH_TS,
  "src/app/layout.tsx": LAYOUT_TSX,
  "src/app/globals.css": GLOBALS_CSS,
  "src/app/page.tsx": PAGE_TSX,
  "src/app/api/health/route.ts": HEALTH_ROUTE,
};

export const FULLSTACK_NEXT_CONTEXT_FILES = [
  "prisma/schema.prisma",
  "src/lib/auth.ts",
  "src/lib/db.ts",
  "src/app/page.tsx",
  "src/app/layout.tsx",
] as const;
