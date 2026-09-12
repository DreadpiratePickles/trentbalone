import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { VerifyCommands } from "@/lib/workbench-verify";

type PackageJson = {
  scripts?: Record<string, string>;
};

export async function resolveWorkbenchVerificationCommands(input: {
  session: WorkbenchSession;
  provider: WorkbenchProviderAdapter;
  packageChanged: boolean;
  executedCommands: string[];
}): Promise<VerifyCommands> {
  const commands: VerifyCommands = {};
  const pkg = await readPackageJson(input.provider, input.session);
  const scripts = pkg?.scripts ?? {};

  if (input.packageChanged) {
    commands.install = latestInstallCommand(input.executedCommands) ?? "npm install --legacy-peer-deps";
  }
  if (scripts.typecheck) commands.typecheck = "npm run typecheck";
  if (scripts.build) commands.build = "npm run build";
  if (scripts.test) commands.test = "npm test";

  return commands;
}

function latestInstallCommand(commands: string[]): string | undefined {
  return commands
    .slice()
    .reverse()
    .find((command) => /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/.test(command));
}

async function readPackageJson(
  provider: WorkbenchProviderAdapter,
  session: WorkbenchSession,
): Promise<PackageJson | undefined> {
  try {
    const raw = await provider.readFile(session, "package.json");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return undefined;
  }
}
