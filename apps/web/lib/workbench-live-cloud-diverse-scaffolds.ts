import { landingPageScaffold } from "@/lib/operating-cycle-deliverables";
import type { AcceptanceStep } from "@/lib/workbench-interaction-verify";

export type DiversePromptId =
  | "static-landing"
  | "nextjs-app"
  | "api-db"
  | "dashboard-chart"
  | "persistent-form";

export type DiversePromptCase = {
  id: DiversePromptId;
  label: string;
  objective: string;
  scaffoldFiles: Record<string, string>;
  installCommand: string;
  postInstallCommands: readonly string[];
  previewCommand: string;
  buildEnv: Record<string, string>;
  expectedTexts: string[];
  interactionSteps: AcceptanceStep[];
};

const VITE_BASE = {
  "vite.config.ts": [
    "import { defineConfig } from 'vite'",
    "import react from '@vitejs/plugin-react'",
    "export default defineConfig({ plugins: [react()], server: { port: 3000, host: true, allowedHosts: true } })",
  ].join("\n"),
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: "react-jsx",
      strict: true,
    },
    include: ["src"],
  }, null, 2),
};

function vitePackage(name: string) {
  return JSON.stringify({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      typecheck: "tsc --noEmit",
      build: "tsc && vite build",
      test: "vitest run",
    },
    dependencies: {
      "@vitejs/plugin-react": "^4.3.1",
      vite: "^5.4.1",
      typescript: "^5.5.3",
      vitest: "^3.1.4",
      react: "^18.3.1",
      "react-dom": "^18.3.1",
      "@types/react": "^18.3.3",
      "@types/react-dom": "^18.3.0",
    },
  }, null, 2);
}

function viteIndex(title: string) {
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\" />",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
    `<title>${title}</title></head><body><div id=\"root\"></div>`,
    "<script type=\"module\" src=\"/src/main.tsx\"></script></body></html>",
  ].join("\n");
}

function viteMain() {
  return [
    "import React from 'react'",
    "import ReactDOM from 'react-dom/client'",
    "import './index.css'",
    "import App from './App'",
    "ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)",
  ].join("\n");
}

function viteSmokeTest() {
  return [
    "import { describe, expect, it } from 'vitest'",
    "describe('smoke', () => { it('passes', () => { expect(true).toBe(true) }) })",
  ].join("\n");
}

function diverseNextJsFiles(): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "trent-diverse-nextjs",
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "next dev -H 0.0.0.0 -p 3000",
        build: "NEXT_TELEMETRY_DISABLED=1 next build --no-lint",
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
      dependencies: {
        next: "14.2.15",
        react: "18.3.1",
        "react-dom": "18.3.1",
      },
      devDependencies: {
        "@types/node": "20.16.0",
        "@types/react": "18.3.3",
        "@types/react-dom": "18.3.0",
        typescript: "5.5.3",
        vitest: "3.1.4",
      },
    }, null, 2),
    "next.config.mjs": [
      "/** @type {import('next').NextConfig} */",
      "const nextConfig = {",
      "  output: 'export',",
      "  images: { unoptimized: true },",
      "  eslint: { ignoreDuringBuilds: true },",
      "  typescript: { ignoreBuildErrors: true },",
      "  productionBrowserSourceMaps: false,",
      "  experimental: { cpus: 1 },",
      "};",
      "export default nextConfig;",
    ].join("\n"),
    "tsconfig.json": JSON.stringify({
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
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
      exclude: ["node_modules"],
    }, null, 2),
    "next-env.d.ts": "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n",
    "pages/_app.tsx": [
      "import type { AppProps } from 'next/app'",
      "export default function App({ Component, pageProps }: AppProps) {",
      "  return <Component {...pageProps} />",
      "}",
    ].join("\n"),
    "pages/index.tsx": [
      "import { useState } from 'react'",
      "export default function Home() {",
      "  const [clicks, setClicks] = useState(0)",
      "  return (",
      "    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', gap: 16 }}>",
      "      <h1>Next.js Proof</h1>",
      "      <p>Built with the Trent diverse prompt runner.</p>",
      "      <button onClick={() => setClicks((c) => c + 1)}>Get started</button>",
      "      {clicks > 0 && <p>Started {clicks} time(s)</p>}",
      "    </main>",
      "  )",
      "}",
    ].join("\n"),
    "src/smoke.test.ts": viteSmokeTest(),
  };
}

function diverseApiDbFiles(): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "trent-diverse-api-db",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: "tsx watch src/server.ts",
        build: "tsc",
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
      dependencies: {
        hono: "^4.6.5",
        "@hono/node-server": "^1.13.2",
        "sql.js": "^1.11.0",
      },
      devDependencies: {
        "@types/node": "^20.16.0",
        "@types/sql.js": "^1.4.9",
        tsx: "^4.19.1",
        typescript: "^5.5.3",
        vitest: "^2.1.3",
      },
    }, null, 2),
    "tsconfig.json": JSON.stringify({
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
      },
      include: ["src"],
      exclude: ["node_modules", "dist"],
    }, null, 2),
    ".env": "PORT=3000\n",
    "src/db.ts": [
      "import initSqlJs, { type Database } from 'sql.js'",
      "import fs from 'node:fs'",
      "import path from 'node:path'",
      "import { randomUUID } from 'node:crypto'",
      "",
      "const DB_PATH = path.join(process.cwd(), 'dev.db')",
      "let dbPromise: Promise<Database> | null = null",
      "",
      "async function openDb(): Promise<Database> {",
      "  const SQL = await initSqlJs()",
      "  const db = fs.existsSync(DB_PATH)",
      "    ? new SQL.Database(fs.readFileSync(DB_PATH))",
      "    : new SQL.Database()",
      "  db.run(`CREATE TABLE IF NOT EXISTS Item (",
      "    id TEXT PRIMARY KEY,",
      "    title TEXT NOT NULL,",
      "    createdAt TEXT NOT NULL DEFAULT (datetime('now'))",
      "  )`)",
      "  return db",
      "}",
      "",
      "export async function getDb(): Promise<Database> {",
      "  if (!dbPromise) dbPromise = openDb()",
      "  return dbPromise",
      "}",
      "",
      "export function persistDb(db: Database): void {",
      "  fs.writeFileSync(DB_PATH, Buffer.from(db.export()))",
      "}",
      "",
      "export type ItemRow = { id: string; title: string; createdAt: string }",
      "",
      "export async function listItems(limit = 50): Promise<ItemRow[]> {",
      "  const db = await getDb()",
      "  const rows = db.exec(`SELECT id, title, createdAt FROM Item ORDER BY createdAt DESC LIMIT ${limit}`)",
      "  if (!rows[0]) return []",
      "  return rows[0].values.map((row) => ({",
      "    id: String(row[0]),",
      "    title: String(row[1]),",
      "    createdAt: String(row[2]),",
      "  }))",
      "}",
      "",
      "export async function createItem(title: string): Promise<ItemRow> {",
      "  const db = await getDb()",
      "  const item = { id: randomUUID(), title, createdAt: new Date().toISOString() }",
      "  db.run('INSERT INTO Item (id, title, createdAt) VALUES (?, ?, ?)', [item.id, item.title, item.createdAt])",
      "  persistDb(db)",
      "  return item",
      "}",
    ].join("\n"),
    "src/app.ts": [
      "import { Hono } from 'hono'",
      "import { createItem, listItems } from './db.js'",
      "export const app = new Hono()",
      "app.get('/api/health', (c) => c.json({ ok: true }))",
      "app.get('/api/items', async (c) => {",
      "  const items = await listItems()",
      "  return c.json({ items })",
      "})",
      "app.post('/api/items', async (c) => {",
      "  const body = await c.req.json().catch(() => ({})) as { title?: unknown }",
      "  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New item'",
      "  const item = await createItem(title)",
      "  return c.json({ item }, 201)",
      "})",
      "app.get('/', async (c) => {",
      "  const items = await listItems(5)",
      "  const rows = items.map((item) => `<li>${item.title}</li>`).join('')",
      "  return c.html(`<!doctype html><html><body><main><h1>API DB Proof</h1><ul>${rows}</ul><button id=\"add\">Add item</button><p id=\"status\"></p><script>document.getElementById('add').addEventListener('click', async () => { const res = await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Saved item' }) }); if (res.ok) document.getElementById('status').textContent = 'Saved item added'; });</script></main></body></html>`)",
      "})",
    ].join("\n"),
    "src/server.ts": [
      "import { serve } from '@hono/node-server'",
      "import { app } from './app.js'",
      "const port = Number(process.env.PORT ?? 3000)",
      "serve({ fetch: app.fetch, hostname: '0.0.0.0', port })",
    ].join("\n"),
    "src/app.test.ts": [
      "import { describe, expect, it } from 'vitest'",
      "import { app } from './app.js'",
      "describe('api', () => { it('health ok', async () => {",
      "  const res = await app.request('/api/health')",
      "  expect(res.status).toBe(200)",
      "}) })",
    ].join("\n"),
  };
}

function diverseDashboardFiles(): Record<string, string> {
  return {
    "package.json": vitePackage("trent-diverse-dashboard"),
    ...VITE_BASE,
    "index.html": viteIndex("Dashboard Proof"),
    "src/main.tsx": viteMain(),
    "src/index.css": "body { margin: 0; font-family: system-ui, sans-serif; background: #0b1020; color: #eef2f8; }",
    "src/App.tsx": [
      "import { useState } from 'react'",
      "const BASE = [{ label: 'Mon', value: 40 }, { label: 'Tue', value: 65 }, { label: 'Wed', value: 52 }]",
      "export default function App() {",
      "  const [seed, setSeed] = useState(0)",
      "  const data = BASE.map((row, i) => ({ ...row, value: row.value + ((seed + i) % 3) * 5 }))",
      "  return (",
      "    <main style={{ minHeight: '100vh', padding: 48 }}>",
      "      <h1>Revenue Dashboard</h1>",
      "      <section aria-label=\"Sales chart\" role=\"img\">",
      "        {data.map((row) => (",
      "          <div key={row.label} style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>",
      "            <span style={{ width: 40 }}>{row.label}</span>",
      "            <div style={{ height: 24, width: row.value * 3, background: '#6ea8fe' }} />",
      "            <span>{row.value}</span>",
      "          </div>",
      "        ))}",
      "      </section>",
      "      <button onClick={() => setSeed((s) => s + 1)}>Refresh chart</button>",
      "      {seed > 0 && <p>Chart refreshed</p>}",
      "    </main>",
      "  )",
      "}",
    ].join("\n"),
    "src/smoke.test.ts": viteSmokeTest(),
  };
}

function diversePersistentFormFiles(): Record<string, string> {
  return {
    "package.json": vitePackage("trent-diverse-form"),
    ...VITE_BASE,
    "index.html": viteIndex("Persistent Form Proof"),
    "src/main.tsx": viteMain(),
    "src/index.css": "body { margin: 0; font-family: system-ui, sans-serif; background: #0b1020; color: #eef2f8; }",
    "src/App.tsx": [
      "import { useEffect, useState } from 'react'",
      "const KEY = 'trent-form-entries'",
      "export default function App() {",
      "  const [entries, setEntries] = useState<string[]>([])",
      "  const [draft, setDraft] = useState('')",
      "  useEffect(() => {",
      "    try { setEntries(JSON.parse(localStorage.getItem(KEY) || '[]')) } catch { setEntries([]) }",
      "  }, [])",
      "  function saveEntry() {",
      "    const next = [...entries, draft.trim() || 'Saved locally']",
      "    setEntries(next)",
      "    localStorage.setItem(KEY, JSON.stringify(next))",
      "    setDraft('')",
      "  }",
      "  return (",
      "    <main style={{ minHeight: '100vh', padding: 48, display: 'grid', gap: 16 }}>",
      "      <h1>Persistent Form</h1>",
      "      <input aria-label=\"entry\" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder=\"Type here\" />",
      "      <button onClick={saveEntry}>Save entry</button>",
      "      <ul>{entries.map((entry, i) => <li key={i}>{entry}</li>)}</ul>",
      "    </main>",
      "  )",
      "}",
    ].join("\n"),
    "src/smoke.test.ts": viteSmokeTest(),
  };
}

export const DIVERSE_PROMPT_CASES: DiversePromptCase[] = [
  {
    id: "static-landing",
    label: "Static landing",
    objective: "Build a static marketing landing page with a waitlist CTA",
    scaffoldFiles: landingPageScaffold({ companyName: "Trent Launch", vision: "Ship products from one prompt." }),
    installCommand: "npm install",
    postInstallCommands: [],
    previewCommand: "npm run dev -- --host 0.0.0.0",
    buildEnv: {},
    expectedTexts: ["Join the waitlist", "Ship products"],
    interactionSteps: [{ action: "click first visible button", expect: "visible text contains \"on the list\"" }],
  },
  {
    id: "nextjs-app",
    label: "Next.js app",
    objective: "Build a minimal Next.js app with an interactive CTA",
    scaffoldFiles: diverseNextJsFiles(),
    installCommand: "npm install --legacy-peer-deps",
    postInstallCommands: [],
    previewCommand: "npm run dev",
    buildEnv: { NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=768" },
    expectedTexts: ["Next.js Proof", "Get started"],
    interactionSteps: [{ action: "click first visible button", expect: "visible text contains \"Started 1 time\"" }],
  },
  {
    id: "api-db",
    label: "API + DB",
    objective: "Build a Hono API with SQLite persistence and a browser UI",
    scaffoldFiles: diverseApiDbFiles(),
    installCommand: "npm install",
    postInstallCommands: [],
    previewCommand: "npm run dev",
    buildEnv: {},
    expectedTexts: ["API DB Proof", "Add item"],
    interactionSteps: [{ action: "click first visible button", expect: "visible text contains \"Saved item\"" }],
  },
  {
    id: "dashboard-chart",
    label: "Dashboard with chart",
    objective: "Build a dashboard with a visible bar chart",
    scaffoldFiles: diverseDashboardFiles(),
    installCommand: "npm install",
    postInstallCommands: [],
    previewCommand: "npm run dev -- --host 0.0.0.0",
    buildEnv: {},
    expectedTexts: ["Revenue Dashboard", "Refresh chart"],
    interactionSteps: [{ action: "click first visible button", expect: "visible text contains \"Chart refreshed\"" }],
  },
  {
    id: "persistent-form",
    label: "Persistent form",
    objective: "Build a form that persists entries in localStorage",
    scaffoldFiles: diversePersistentFormFiles(),
    installCommand: "npm install",
    postInstallCommands: [],
    previewCommand: "npm run dev -- --host 0.0.0.0",
    buildEnv: {},
    expectedTexts: ["Persistent Form", "Save entry"],
    interactionSteps: [{ action: "click first visible button", expect: "visible text contains \"Saved locally\"" }],
  },
];

export function getDiversePromptCase(id: DiversePromptId): DiversePromptCase {
  const found = DIVERSE_PROMPT_CASES.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown diverse prompt id: ${id}`);
  return found;
}
