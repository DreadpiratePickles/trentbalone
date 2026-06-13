import { store } from "@/lib/store";
import { decryptJson } from "@/lib/secrets";
import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "./workbench-provider";

export class GitCredentialsNotFoundError extends Error {
  constructor(public provider: string) {
    super(`VCS Credentials not configured for provider: ${provider}`);
    this.name = "GitCredentialsNotFoundError";
  }
}

export function getGitProviderFromUrl(url: string): "GitHub" | "GitLab" | "Bitbucket" | undefined {
  const lower = url.toLowerCase();
  if (lower.includes("github.com")) return "GitHub";
  if (lower.includes("gitlab.com")) return "GitLab";
  if (lower.includes("bitbucket.org")) return "Bitbucket";
  return undefined;
}

export function getGitUserForProvider(provider: string): string {
  switch (provider) {
    case "GitHub": return "x-access-token";
    case "GitLab": return "oauth2";
    case "Bitbucket": return "x-token-auth";
    default: return "git";
  }
}

export async function resolveGitCredentials(
  companyId: string,
  provider: string
): Promise<{ username: string; token: string }> {
  const connection = await store.getIntegration(companyId, provider);
  if (!connection || !connection.encryptedData) {
    throw new GitCredentialsNotFoundError(provider);
  }
  
  try {
    const data = decryptJson<{ token: string }>(connection.encryptedData);
    if (!data.token) {
      throw new GitCredentialsNotFoundError(provider);
    }
    return {
      username: getGitUserForProvider(provider),
      token: data.token
    };
  } catch {
    throw new GitCredentialsNotFoundError(provider);
  }
}

export async function setupSandboxGitAuth(
  session: WorkbenchSession,
  adapter: WorkbenchProviderAdapter
): Promise<Record<string, string>> {
  if (!session.repoUrl) {
    throw new Error("No repository URL configured for this session");
  }

  const provider = getGitProviderFromUrl(session.repoUrl);
  if (!provider) {
    throw new Error(`Unsupported VCS provider in URL: ${session.repoUrl}`);
  }

  const { username, token } = await resolveGitCredentials(session.companyId, provider);

  // 1. Write the transient GIT_ASKPASS helper script inside the sandbox guest OS
  const askpassScript = [
    "#!/bin/sh",
    "case \"$1\" in",
    "  *Username*) echo \"${GIT_USER:-git}\" ;;",
    "  *) echo \"$GIT_TOKEN\" ;;",
    "esac",
    "",
  ].join("\n");
  await adapter.writeFile(session, "/tmp/git-askpass.sh", askpassScript);

  // 2. Set execute permissions
  const chmod = await adapter.exec(session, "chmod +x /tmp/git-askpass.sh");
  if (chmod.exitCode !== 0) {
    throw new Error(`Could not make Git askpass helper executable: ${chmod.stderr || chmod.stdout || "unknown chmod failure"}`);
  }

  // 3. Configure the git username so it invokes GIT_ASKPASS
  await adapter.exec(session, `git config --global credential.username ${username}`);

  return {
    GIT_TOKEN: token,
    GIT_ASKPASS: "/tmp/git-askpass.sh",
    GIT_TERMINAL_PROMPT: "0",
    GIT_USER: username
  };
}

export async function checkoutRepository(
  session: WorkbenchSession,
  adapter: WorkbenchProviderAdapter,
  branch?: string
): Promise<void> {
  if (!session.repoUrl) {
    throw new Error("No repository URL configured for this session");
  }

  let authEnv: Record<string, string> = {};
  try {
    authEnv = await setupSandboxGitAuth(session, adapter);
  } catch (err) {
    if (!(err instanceof GitCredentialsNotFoundError)) throw err;
    // Public repositories can be cloned without credentials. If the clone
    // fails, we add a private-repo credential hint to that failure.
    authEnv = {};
  }

  const execOptions = Object.keys(authEnv).length ? { env: authEnv } : undefined;

  // 1. Run git clone into the active workbench directory (.)
  const cloneRes = await adapter.exec(session, `git clone ${session.repoUrl} .`, execOptions);

  if (cloneRes.exitCode !== 0) {
    const provider = getGitProviderFromUrl(session.repoUrl);
    const credentialHint = Object.keys(authEnv).length || !provider
      ? ""
      : ` Configure ${provider} credentials for this company if the repository is private.`;
    const detail = commandFailureDetail(cloneRes);
    throw new Error(`Git clone failed with code ${cloneRes.exitCode}: ${detail}${credentialHint}`);
  }

  // 2. Checkout the desired branch if specified
  if (branch) {
    const checkoutRes = await adapter.exec(session, `git checkout ${branch}`, execOptions);

    if (checkoutRes.exitCode !== 0) {
      // Fallback: try creating the branch locally
      const createBranchRes = await adapter.exec(session, `git checkout -b ${branch}`, execOptions);
      if (createBranchRes.exitCode !== 0) {
        throw new Error(`Git checkout for branch ${branch} failed: ${commandFailureDetail(createBranchRes)}`);
      }
    }
  }
}

function commandFailureDetail(result: { stdout?: string; stderr?: string }): string {
  return [result.stderr, result.stdout]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n")
    || "no command output";
}
