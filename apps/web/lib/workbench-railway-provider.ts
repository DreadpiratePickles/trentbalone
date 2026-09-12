/**
 * Railway Workbench Provider
 *
 * Production sandbox for Railway-hosted deployments.
 *
 * Delegates entirely to the container-local (mock_local) implementation.
 * The Railway container runtime is the isolation boundary — each service
 * instance runs in its own container with an ephemeral filesystem and
 * stripped network access to sibling services. No external VM or sandbox
 * API is required.
 *
 * What you get:
 *  - Per-session isolated temp directories under /tmp/trent-workbench/
 *  - Full host-secret stripping (DATABASE_URL, API keys, etc. are redacted)
 *  - Shell command allowlist (same as mock_local)
 *  - Background preview server management on internal ports
 *  - Playwright screenshots with `--no-sandbox` (required in containers);
 *    falls back to SVG placeholder if chromium is not installed.
 *
 * Set WORKBENCH_DEFAULT_PROVIDER=railway in Railway environment variables.
 * Playwright: Railway's nixpacks.toml installs chromium system deps so that
 * `npx playwright install chromium` works without --with-deps.
 */

import { localProvider } from "@/lib/workbench-local-provider";
import { registerWorkbenchProvider } from "@/lib/workbench-provider";

registerWorkbenchProvider({ ...localProvider, name: "railway" });
