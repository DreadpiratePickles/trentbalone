export type AppBuilderLanguage = "typescript" | "python" | "go" | "ruby" | "rust" | "dart";
export type AppBuilderDetectedFramework = "nextjs" | "vite_react" | "remix" | "sveltekit" | "astro" | "nuxt" | "expo" | "react_native" | "flutter";

export type FrameworkCapability = {
  framework: AppBuilderDetectedFramework;
  supportsServerRoutes: boolean;
  supportsMobileBuilds: boolean;
  defaultLanguage: AppBuilderLanguage;
};

const FRAMEWORKS: Record<AppBuilderDetectedFramework, FrameworkCapability> = {
  nextjs: { framework: "nextjs", supportsServerRoutes: true, supportsMobileBuilds: false, defaultLanguage: "typescript" },
  vite_react: { framework: "vite_react", supportsServerRoutes: false, supportsMobileBuilds: false, defaultLanguage: "typescript" },
  remix: { framework: "remix", supportsServerRoutes: true, supportsMobileBuilds: false, defaultLanguage: "typescript" },
  sveltekit: { framework: "sveltekit", supportsServerRoutes: true, supportsMobileBuilds: false, defaultLanguage: "typescript" },
  astro: { framework: "astro", supportsServerRoutes: true, supportsMobileBuilds: false, defaultLanguage: "typescript" },
  nuxt: { framework: "nuxt", supportsServerRoutes: true, supportsMobileBuilds: false, defaultLanguage: "typescript" },
  expo: { framework: "expo", supportsServerRoutes: false, supportsMobileBuilds: true, defaultLanguage: "typescript" },
  react_native: { framework: "react_native", supportsServerRoutes: false, supportsMobileBuilds: true, defaultLanguage: "typescript" },
  flutter: { framework: "flutter", supportsServerRoutes: false, supportsMobileBuilds: true, defaultLanguage: "dart" },
};

export function detectFrameworks(input: {
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  files?: string[];
}): AppBuilderDetectedFramework[] {
  const deps = { ...(input.packageJson?.dependencies ?? {}), ...(input.packageJson?.devDependencies ?? {}) };
  const found: AppBuilderDetectedFramework[] = [];
  addIf(found, "nextjs", "next" in deps);
  addIf(found, "vite_react", "vite" in deps && ("react" in deps || "@vitejs/plugin-react" in deps));
  addIf(found, "remix", "@remix-run/react" in deps || "@remix-run/node" in deps);
  addIf(found, "sveltekit", "@sveltejs/kit" in deps);
  addIf(found, "astro", "astro" in deps);
  addIf(found, "nuxt", "nuxt" in deps);
  addIf(found, "expo", "expo" in deps);
  addIf(found, "react_native", "react-native" in deps && !("expo" in deps));
  addIf(found, "flutter", (input.files ?? []).some((file) => file.endsWith("pubspec.yaml")));
  return found;
}

export function detectLanguages(files: string[]): AppBuilderLanguage[] {
  const languages: AppBuilderLanguage[] = [];
  addIf(languages, "typescript", files.some((file) => /\.(ts|tsx)$/.test(file)));
  addIf(languages, "python", files.some((file) => file.endsWith(".py")));
  addIf(languages, "go", files.some((file) => file.endsWith(".go")));
  addIf(languages, "ruby", files.some((file) => file.endsWith(".rb")));
  addIf(languages, "rust", files.some((file) => file.endsWith(".rs")));
  addIf(languages, "dart", files.some((file) => file.endsWith(".dart") || file.endsWith("pubspec.yaml")));
  return languages;
}

export function getFrameworkCapability(framework: AppBuilderDetectedFramework) {
  return FRAMEWORKS[framework];
}

export function recommendScaffold(framework: AppBuilderDetectedFramework) {
  if (framework === "expo") {
    return { packageManager: "npm", devCommand: "npx expo start", testCommand: "npm test" };
  }
  if (framework === "vite_react") {
    return { packageManager: "npm", devCommand: "npm run dev", testCommand: "npm test" };
  }
  if (framework === "flutter") {
    return { packageManager: "flutter", devCommand: "flutter run", testCommand: "flutter test" };
  }
  return { packageManager: "npm", devCommand: "npm run dev", testCommand: "npm test" };
}

function addIf<T>(items: T[], item: T, condition: boolean) {
  if (condition && !items.includes(item)) items.push(item);
}
