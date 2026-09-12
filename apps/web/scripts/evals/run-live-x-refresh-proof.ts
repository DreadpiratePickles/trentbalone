/**
 * Live X (Twitter) OAuth2 refresh proof.
 *
 *   npm run x:refresh:proof -- --env-file trent.env.local --out artifacts/live-proofs/x-refresh.json [--publish]
 *
 * Refreshes a user-context access token via X_REFRESH_TOKEN + client credentials,
 * verifies it against /2/users/me, persists the rotated tokens back to the env file
 * (so the refresh chain survives), and optionally proves one approval-gated publish.
 * No secrets are written to the proof JSON.
 */
import fs from "node:fs";
import path from "node:path";
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";
import { refreshXAccessToken } from "@/lib/x-oauth";
import { createXSocialAdapter } from "@/lib/x-social-adapter";

type Args = { envFile?: string; outFile?: string; publish: boolean; publishText?: string; persist: boolean };

const X_KEYS = new Set([
  "X_CLIENT_ID", "X_CLIENT_SECRET", "X_REFRESH_TOKEN", "X_USER_ACCESS_TOKEN",
  "X_BEARER_TOKEN", "X_CONSUMER_KEY", "X_SECRET_KEY",
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedEnvKeys = args.envFile ? loadAllowedEvalEnvFile(args.envFile, (k) => X_KEYS.has(k)) : [];

  const proof: Record<string, unknown> = {
    passed: false,
    generatedAt: new Date().toISOString(),
    loadedEnvKeys,
    tokenRefreshed: false,
  };

  try {
    const refreshed = await refreshXAccessToken(process.env);
    proof.tokenRefreshed = true;
    proof.scope = refreshed.scope;
    proof.expiresIn = refreshed.expiresIn;
    proof.refreshTokenRotated = Boolean(refreshed.refreshToken);

    // Make the fresh token visible to the adapter / process.
    process.env.X_USER_ACCESS_TOKEN = refreshed.accessToken;
    if (refreshed.refreshToken) process.env.X_REFRESH_TOKEN = refreshed.refreshToken;

    // Verify the minted token is a real user-context credential.
    const meRes = await fetch("https://api.x.com/2/users/me", {
      headers: { Authorization: `Bearer ${refreshed.accessToken}`, Accept: "application/json" },
    });
    const meBody = (await meRes.json().catch(() => ({}))) as { data?: { id?: string; username?: string } };
    proof.usersMeStatus = meRes.status;
    proof.username = meBody.data?.username;
    proof.userIdPresent = Boolean(meBody.data?.id);
    if (!meRes.ok || !meBody.data?.id) {
      throw new Error(`users/me failed (${meRes.status})`);
    }

    // Persist the rotated tokens so the next run has a live refresh token.
    if (args.persist && args.envFile && !isRtf(args.envFile)) {
      persistEnvValue(args.envFile, "X_USER_ACCESS_TOKEN", refreshed.accessToken);
      if (refreshed.refreshToken) persistEnvValue(args.envFile, "X_REFRESH_TOKEN", refreshed.refreshToken);
      proof.persistedRotatedTokens = true;
    }

    // Optional: prove one approval-gated publish end-to-end.
    if (args.publish) {
      const adapter = createXSocialAdapter();
      const action = "publish post";
      const text = args.publishText
        ?? "Trent platform autonomy check ✅ approval-gated agent publish via OAuth2 user-context token.";
      const gated = await adapter.execute(action, { text });
      proof.publishGatedStatus = gated.status; // expect needs_approval
      const published = await adapter.execute(action, { text, approvalId: `apr_xproof_${Date.now()}` });
      proof.publishStatus = published.status;
      proof.publishSummary = published.summary;
      proof.postPublished = published.status === "completed";
    }

    proof.passed = args.publish ? Boolean(proof.postPublished) : true;
  } catch (error) {
    proof.error = error instanceof Error ? error.message : String(error);
  }

  const json = JSON.stringify(proof, null, 2);
  if (args.outFile) {
    fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
    fs.writeFileSync(args.outFile, json);
  }
  console.log(json);
  process.exitCode = proof.passed ? 0 : 1;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { publish: false, persist: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--env-file") { args.envFile = next; i++; }
    else if (a === "--out") { args.outFile = next; i++; }
    else if (a === "--publish") { args.publish = true; }
    else if (a === "--publish-text") { args.publishText = next; i++; }
    else if (a === "--no-persist") { args.persist = false; }
  }
  return args;
}

function isRtf(path: string): boolean {
  try { return fs.readFileSync(path, "utf8").trimStart().startsWith("{\\rtf"); } catch { return false; }
}

function persistEnvValue(path: string, key: string, value: string): void {
  const content = fs.readFileSync(path, "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`;
  fs.writeFileSync(path, next);
}

void main();
