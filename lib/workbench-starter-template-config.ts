/** Config and scaffold files for the Workbench Vite + Tailwind + shadcn starter. */

export const STARTER_PACKAGE_JSON = JSON.stringify({
  name: "trent-app",
  version: "0.1.0",
  private: true,
  type: "module",
  scripts: {
    // Bind to 0.0.0.0:3000 explicitly via CLI flags. These override vite.config.ts
    // and the cloud sandbox proxy (E2B/Daytona) exposes port 3000. Vite ignores the
    // PORT env var, so the flags are the authoritative source of the listen port.
    dev: "vite --host 0.0.0.0 --port 3000",
    build: "tsc && vite build",
    typecheck: "tsc --noEmit",
    preview: "vite preview --host 0.0.0.0 --port 3000",
  },
  dependencies: {
    react: "^18.3.1",
    "react-dom": "^18.3.1",
    "@radix-ui/react-dialog": "^1.1.2",
    "@radix-ui/react-dropdown-menu": "^2.1.2",
    "@radix-ui/react-slot": "^1.1.0",
    "@radix-ui/react-tabs": "^1.1.1",
    "@radix-ui/react-toast": "^1.2.2",
    "class-variance-authority": "^0.7.0",
    clsx: "^2.1.1",
    "lucide-react": "^0.460.0",
    "tailwind-merge": "^2.5.4",
  },
  devDependencies: {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    autoprefixer: "^10.4.20",
    postcss: "^8.4.47",
    tailwindcss: "^3.4.14",
    "tailwindcss-animate": "^1.0.7",
    typescript: "^5.5.3",
    vite: "^5.4.1",
  },
}, null, 2);

export const STARTER_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

export const STARTER_VITE_CONFIG = `import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: { port: 3000, host: true },
})`;

export const STARTER_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2020",
    useDefineForClassFields: true,
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
    noUnusedLocals: true,
    noUnusedParameters: true,
    noFallthroughCasesInSwitch: true,
    baseUrl: ".",
    paths: {
      "@/*": ["./src/*"],
    },
  },
  include: ["src"],
}, null, 2);

export const STARTER_POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}`;

export const STARTER_TAILWIND_CONFIG = `import type { Config } from "tailwindcss"
import animate from "tailwindcss-animate"

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [animate],
} satisfies Config`;

export const STARTER_GLOBALS_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    /* Trent dark palette — mapped to shadcn theme tokens */
    --background: 220 33% 4%;          /* #080a0f */
    --foreground: 214 33% 93%;         /* #e7edf6 */
    --card: 220 30% 7%;                /* #0e131d */
    --card-foreground: 214 33% 93%;
    --popover: 220 30% 7%;
    --popover-foreground: 214 33% 93%;
    --primary: 213 93% 68%;            /* #60a5fa */
    --primary-foreground: 220 33% 4%;
    --secondary: 220 28% 12%;          /* #131b2a */
    --secondary-foreground: 213 30% 85%; /* #cbd7e7 */
    --muted: 220 26% 16%;              /* #1a2236 */
    --muted-foreground: 213 18% 65%;   /* #92a3b8 */
    --accent: 220 28% 12%;
    --accent-foreground: 214 33% 93%;
    --destructive: 0 91% 71%;          /* #f87171 */
    --destructive-foreground: 220 33% 4%;
    --border: 220 24% 17%;             /* #1d2738 */
    --input: 220 24% 17%;
    --ring: 213 93% 68%;
    --radius: 0.25rem;                 /* 4px */
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground antialiased;
    font-family: system-ui, -apple-system, sans-serif;
    min-height: 100vh;
  }
}`;

export const STARTER_UTILS = `import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}`;

export const STARTER_MAIN = `import React from "react"
import ReactDOM from "react-dom/client"
import "./globals.css"
import App from "./App"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`;

export const STARTER_APP = `import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function App() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 p-8">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Ready to build</CardTitle>
            <CardDescription>
              Compose UIs from shadcn/ui primitives in{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-sm">src/components/ui/</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button>Get started</Button>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}`;
