import type { ToolCallRecord } from "@/lib/types";
import { createGitHubIssue, getGitHubCredentials } from "@/lib/github";
import { assertToolSpendAllowed } from "@/lib/spend";
import { logger } from "@/lib/logger";
import { CamofoxBrowserClient, buildCamofoxToolScopes } from "@/lib/camofox-browser";
import { SteelBrowserClient, buildSteelToolScopes } from "@/lib/steel-browser";
import { sandboxToolAdapters } from "@/lib/sandbox-tool-adapters";
import { GitNexusVaultIndexAdapter } from "@/lib/vault-memory";
import { toolUnavailableResult } from "@/lib/provider-readiness";
import { createResendEmailAdapter } from "@/lib/resend-email-adapter";
import { createStripeReadAdapter } from "@/lib/stripe-read-adapter";
import { createSentryReadAdapter } from "@/lib/sentry-read-adapter";
import { createPostHogReadAdapter } from "@/lib/posthog-read-adapter";
import { createXSocialAdapter } from "@/lib/x-social-adapter";
import { createAttioCrmAdapter } from "@/lib/attio-crm-adapter";
import { createWebSearchAdapter } from "@/lib/web-search-adapter";
import { createSlackAdapter } from "@/lib/slack-adapter";
import { createWebReaderAdapter } from "@/lib/web-reader-adapter";

export type ToolAdapter = {
  name: string;
  scopes: string[];
  /** Real = configured adapter, unavailable = visible but blocked, test_only = mocks/dev fallback only. */
  availability?: "real" | "unavailable" | "test_only";
  /** If true, real external money can be spent — pre-flight check runs before execute */
  spendsMoneyOnExecute?: boolean;
  /** Custom approval expiry in hours (default: 48 h) */
  approvalExpiryHours?: number;
  healthCheck: (companyId?: string) => Promise<"mocked" | "connected" | "needs_credentials">;
  estimateCost: () => number;
  requiresApproval: (action: string) => boolean;
  execute: (action: string, payload: Record<string, unknown>) => Promise<ToolCallRecord>;
  dryRun?: (action: string, payload: Record<string, unknown>) => Promise<ToolCallRecord>;
  fallbackAdapterName?: string;
};

function mockedAdapter(
  name: string,
  scopes: string[],
  approvalWords: string[],
  opts: { spendsMoneyOnExecute?: boolean; estimatedCents?: number; approvalExpiryHours?: number } = {}
): ToolAdapter {
  return {
    name,
    scopes,
    availability: "test_only",
    spendsMoneyOnExecute: opts.spendsMoneyOnExecute,
    approvalExpiryHours: opts.approvalExpiryHours,
    async healthCheck() {
      return "mocked";
    },
    estimateCost() {
      return opts.estimatedCents ?? 0;
    },
    requiresApproval(action) {
      return approvalWords.some((word) => action.toLowerCase().includes(word));
    },
    async execute(action, payload) {
      const unavailable = toolUnavailableResult(this, action);
      if (unavailable) return unavailable;
      // Pre-flight: if this adapter spends real money, assert budget before executing
      const companyId = typeof payload.companyId === "string" ? payload.companyId : undefined;
      const needsApproval = this.requiresApproval(action);
      logger.info({ toolName: name, action, companyId, needsApproval }, "tool.execute");
      if (opts.spendsMoneyOnExecute && opts.estimatedCents) {
        if (companyId) {
          await assertToolSpendAllowed(companyId, name, opts.estimatedCents);
        }
      }
      return {
        adapter: name,
        action,
        status: needsApproval ? "needs_approval" : "mocked",
        summary: `${name} is mocked. Trent recorded the intended "${action}" action without external side effects.`
      };
    },
    async dryRun(action) {
      return {
        adapter: name,
        action,
        status: "mocked",
        summary: `${name} dry-run: Trent would attempt "${action}" without external side effects.`
      };
    },
    fallbackAdapterName: undefined,
  };
}

function unavailableAdapter(name: string, scopes: string[], approvalWords: string[]): ToolAdapter {
  return {
    name,
    scopes,
    availability: "unavailable",
    async healthCheck() {
      return "needs_credentials";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return approvalWords.some((word) => action.toLowerCase().includes(word));
    },
    async execute(action) {
      return {
        adapter: name,
        action,
        status: "failed",
        summary: `${name} is not configured. Connect real provider credentials before agents can use this tool.`,
      };
    },
  };
}

export type AdapterRegistryOptions = {
  env?: NodeJS.ProcessEnv;
};

export function buildAdapterRegistry(options: AdapterRegistryOptions = {}): ToolAdapter[] {
  const env = options.env ?? process.env;
  return [
  {
    name: "GitHub",
    scopes: ["repo:read", "issues:write", "pull_requests:write", "github:read", "github:issue", "github:branch_scaffold"],
    availability: "real",
    async healthCheck(companyId?: string) {
      return (await getGitHubCredentials(companyId)) ? "connected" : "needs_credentials";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return ["issue", "branch", "merge", "delete", "release", "deploy"].some((word) => action.toLowerCase().includes(word));
    },
    async execute(action, payload) {
      const companyId = typeof payload.companyId === "string" ? payload.companyId : undefined;
      const status = await this.healthCheck(companyId);
      if (status !== "connected") {
        return {
          adapter: "GitHub",
          action,
          status: "failed",
          summary: "GitHub credentials are not configured. Connect a GitHub App/token before agents can create issues or PRs."
        };
      }
      if (action.toLowerCase().includes("issue")) {
        return createGitHubIssue(companyId ?? "", {
          title: typeof payload.title === "string" ? payload.title : "Trent Operating Cycle Plan",
          body: typeof payload.body === "string" ? payload.body : "This issue tracks the implementation details and task progress generated by Trent in the latest operating cycle.",
          labels: Array.isArray(payload.labels) ? payload.labels.filter((item): item is string => typeof item === "string") : ["trent", "ai-cofounder"]
        });
      }
      return {
        adapter: "GitHub",
        action,
        status: this.requiresApproval(action) ? "needs_approval" : "completed",
        summary: "GitHub adapter is credential-ready; write actions remain approval-gated in Phase 1."
      };
    }
  },
  {
    name: "Steel Browser",
    scopes: buildSteelToolScopes(),
    availability: "real",
    spendsMoneyOnExecute: true,
    async healthCheck() {
      return new SteelBrowserClient().healthCheck();
    },
    estimateCost() {
      return 1;
    },
    requiresApproval(action) {
      return ["login", "submit", "purchase", "download", "cookie", "auth", "form"].some((word) =>
        action.toLowerCase().includes(word),
      );
    },
    async execute(action, payload) {
      if (this.requiresApproval(action)) {
        return {
          adapter: "Steel Browser",
          action,
          status: "needs_approval",
          summary: `Steel Browser action "${action}" requires approval before Trent touches authenticated or side-effecting web state.`,
        };
      }

      const companyId = typeof payload.companyId === "string" ? payload.companyId : undefined;
      if (companyId) {
        await assertToolSpendAllowed(companyId, "Steel Browser", this.estimateCost());
      }

      const client = new SteelBrowserClient();
      const url = typeof payload.url === "string" ? payload.url : undefined;
      if (!url && ["scrape", "screenshot", "pdf"].includes(action)) {
        return {
          adapter: "Steel Browser",
          action,
          status: "failed",
          summary: `Steel Browser action "${action}" requires payload.url.`,
        };
      }

      try {
        if (action === "scrape") {
          const result = await client.scrape({
            url: url!,
            format: Array.isArray(payload.format)
              ? payload.format.filter((item): item is "html" | "cleaned_html" | "markdown" | "readability" =>
                  item === "html" || item === "cleaned_html" || item === "markdown" || item === "readability",
                )
              : undefined,
            screenshot: payload.screenshot === true,
            pdf: payload.pdf === true,
          });
          const content = result.content && typeof result.content === "object" ? result.content : {};
          const markdown = "markdown" in content && typeof (content as { markdown?: unknown }).markdown === "string"
            ? (content as { markdown: string }).markdown
            : "";
          return {
            adapter: "Steel Browser",
            action,
            status: "completed",
            summary: `Scraped ${url} with Steel Browser${markdown ? ` (${markdown.length} markdown characters)` : ""}.`,
          };
        }

        if (action === "screenshot") {
          const screenshot = await client.screenshot({ url: url!, fullPage: payload.fullPage === true });
          return {
            adapter: "Steel Browser",
            action,
            status: "completed",
            summary: `Captured Steel Browser screenshot for ${url} (${screenshot.length} bytes).`,
          };
        }

        if (action === "pdf") {
          const pdf = await client.pdf({ url: url! });
          return {
            adapter: "Steel Browser",
            action,
            status: "completed",
            summary: `Captured Steel Browser PDF for ${url} (${pdf.length} bytes).`,
          };
        }

        if (action === "sessions") {
          return {
            adapter: "Steel Browser",
            action,
            status: "failed",
            summary: "Steel Sessions are not configured. Use Playwright preview verification or connect an explicit session browser provider.",
          };
        }

        return {
          adapter: "Steel Browser",
          action,
          status: "failed",
          summary: `Unsupported Steel Browser action "${action}".`,
        };
      } catch (err: unknown) {
        return {
          adapter: "Steel Browser",
          action,
          status: "failed",
          summary: (err as Error).message,
        };
      }
    },
    async dryRun(action) {
      return {
        adapter: "Steel Browser",
        action,
        status: this.requiresApproval(action) ? "needs_approval" : "mocked",
        summary: `Steel Browser dry-run: Trent would execute "${action}" through Steel's browser tools.`,
      };
    },
    fallbackAdapterName: "Camofox",
  },
  {
    name: "Camofox",
    scopes: buildCamofoxToolScopes(),
    availability: "real",
    async healthCheck() {
      return new CamofoxBrowserClient().healthCheck();
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return ["login", "submit", "purchase", "download", "cookie", "auth"].some((word) =>
        action.toLowerCase().includes(word),
      );
    },
    async execute(action, payload) {
      if (this.requiresApproval(action)) {
        return {
          adapter: "Camofox",
          action,
          status: "needs_approval",
          summary: `Camofox action "${action}" requires approval before Trent touches authenticated or side-effecting browser state.`,
        };
      }

      const client = new CamofoxBrowserClient();
      const userId = typeof payload.userId === "string" ? payload.userId : undefined;
      const tabId = typeof payload.tabId === "string" ? payload.tabId : undefined;

      try {
        if (action === "create_tab") {
          const tab = await client.createTab({
            userId,
            sessionKey: typeof payload.sessionKey === "string" ? payload.sessionKey : undefined,
            url: typeof payload.url === "string" ? payload.url : undefined,
          });
          return {
            adapter: "Camofox",
            action,
            status: "completed",
            summary: `Created Camofox tab ${tab.id}${tab.url ? ` at ${tab.url}` : ""}.`,
          };
        }

        if (!tabId) {
          return {
            adapter: "Camofox",
            action,
            status: "failed",
            summary: `Camofox action "${action}" requires payload.tabId.`,
          };
        }

        if (action === "navigate") {
          await client.navigate(tabId, {
            userId,
            url: typeof payload.url === "string" ? payload.url : undefined,
            macro: typeof payload.macro === "string" ? payload.macro : undefined,
            query: typeof payload.query === "string" ? payload.query : undefined,
          });
          return { adapter: "Camofox", action, status: "completed", summary: `Navigated Camofox tab ${tabId}.` };
        }

        if (action === "snapshot") {
          const snapshot = await client.snapshot(tabId, {
            userId,
            includeScreenshot: payload.includeScreenshot === true,
            offset: typeof payload.offset === "number" ? payload.offset : undefined,
          });
          return {
            adapter: "Camofox",
            action,
            status: "completed",
            summary: `Captured Camofox snapshot for tab ${tabId} (${snapshot.snapshot.length} characters).`,
          };
        }

        if (action === "click") {
          await client.click(tabId, {
            userId,
            ref: typeof payload.ref === "string" ? payload.ref : undefined,
            selector: typeof payload.selector === "string" ? payload.selector : undefined,
          });
          return { adapter: "Camofox", action, status: "completed", summary: `Clicked in Camofox tab ${tabId}.` };
        }

        if (action === "type") {
          const text = typeof payload.text === "string" ? payload.text : "";
          await client.type(tabId, {
            userId,
            ref: typeof payload.ref === "string" ? payload.ref : undefined,
            selector: typeof payload.selector === "string" ? payload.selector : undefined,
            text,
            pressEnter: payload.pressEnter === true,
          });
          return { adapter: "Camofox", action, status: "completed", summary: `Typed ${text.length} characters in Camofox tab ${tabId}.` };
        }

        if (action === "screenshot") {
          const screenshot = await client.screenshot(tabId, { userId });
          return {
            adapter: "Camofox",
            action,
            status: "completed",
            summary: `Captured Camofox screenshot for tab ${tabId} (${screenshot.length} bytes).`,
          };
        }

        if (action === "scroll") {
          const direction = typeof payload.direction === "string" ? payload.direction : "down";
          if (!["up", "down", "left", "right"].includes(direction)) {
            return {
              adapter: "Camofox",
              action,
              status: "failed",
              summary: `Unsupported Camofox scroll direction "${direction}".`,
            };
          }
          await client.scroll(tabId, {
            userId,
            direction: direction as "up" | "down" | "left" | "right",
            amount: typeof payload.amount === "number" ? payload.amount : undefined,
          });
          return { adapter: "Camofox", action, status: "completed", summary: `Scrolled ${direction} in Camofox tab ${tabId}.` };
        }

        if (action === "close_tab") {
          await client.closeTab(tabId, { userId });
          return { adapter: "Camofox", action, status: "completed", summary: `Closed Camofox tab ${tabId}.` };
        }

        return {
          adapter: "Camofox",
          action,
          status: "failed",
          summary: `Unsupported Camofox action "${action}".`,
        };
      } catch (err: unknown) {
        return {
          adapter: "Camofox",
          action,
          status: "failed",
          summary: (err as Error).message,
        };
      }
    },
    async dryRun(action) {
      return {
        adapter: "Camofox",
        action,
        status: this.requiresApproval(action) ? "needs_approval" : "mocked",
        summary: `Camofox dry-run: Trent would execute "${action}" through the configured Camofox browser server.`,
      };
    },
  },
  new GitNexusVaultIndexAdapter({ enabled: env.GITNEXUS_VAULT_ENABLED === "1" }),
  ...sandboxToolAdapters,
  createResendEmailAdapter({ env }),
  createWebSearchAdapter({ env }),
  mockedAdapter("Anthropic", ["llm:primary", "model_telemetry"], []),
  mockedAdapter("AWS Bedrock", ["llm:fallback", "model_routing"], []),
  mockedAdapter("OpenAI", ["llm", "video_generation"], []),
  mockedAdapter("Fal.ai", ["image_generation", "video_generation", "audio_generation"], ["publish"]),
  mockedAdapter("Cloudflare R2", ["asset_storage", "generated_media"], ["delete"]),
  unavailableAdapter("Postmark", ["transactional_email", "inbound_email"], ["send"]),
  mockedAdapter("Hunter.io", ["email_verification", "deliverability"], []),
  mockedAdapter("Meta Ads", ["draft_campaign", "launch_requires_approval"], ["launch", "spend", "budget"], { spendsMoneyOnExecute: true, estimatedCents: 500, approvalExpiryHours: 12 }),
  mockedAdapter("Meta Pixel/CAPI", ["conversion_events", "attribution"], ["send", "identify"]),
  createStripeReadAdapter({ env }),
  mockedAdapter("Google OAuth/Gmail", ["auth", "gmail_draft", "send_requires_approval"], ["send"]),
  createSlackAdapter({ env }),
  createWebReaderAdapter({ env }),
  createXSocialAdapter({ env }),
  createAttioCrmAdapter({ env }),
  unavailableAdapter("Late.dev", ["social_schedule", "multi_platform_posting"], ["publish", "post"]),
  mockedAdapter("Browserbase", ["cloud_browser", "screenshots", "extraction"], ["submit", "purchase", "login"]),
  mockedAdapter("ScreenshotOne", ["automated_screenshots"], []),
  mockedAdapter("Render", ["hosting", "deploy_requires_approval"], ["deploy", "rollback"]),
  mockedAdapter("Neon", ["postgres", "database_provisioning"], ["delete", "rotate"]),
  mockedAdapter("Expo", ["mobile_builds", "eas_distribution"], ["submit", "publish"]),
  createSentryReadAdapter({ env }),
  createPostHogReadAdapter({ env }),
  mockedAdapter("IPinfo", ["ip_geolocation", "enrichment"], [])
  ];
}

export const adapters: ToolAdapter[] = buildAdapterRegistry();

export const DEFAULT_APPROVAL_EXPIRY_HOURS = 48;

/**
 * Get the effective approval expiry hours for a tool, considering company-level overrides.
 * Precedence: company override > adapter default > global default (48 h).
 */
export function getApprovalExpiryHours(
  toolName: string,
  companyOverrides?: Record<string, number>
): number {
  if (companyOverrides?.[toolName] !== undefined) return companyOverrides[toolName];
  const adapter = adapters.find((a) => a.name === toolName);
  if (adapter?.approvalExpiryHours !== undefined) return adapter.approvalExpiryHours;
  return DEFAULT_APPROVAL_EXPIRY_HOURS;
}

/** Only adapters that have approval-required actions are relevant for expiry settings */
export function getApprovalRelevantAdapters() {
  return adapters.filter((a) => {
    // Has at least one approval-triggering word
    const sampleActions = ["send", "publish", "launch", "deploy", "charge"];
    return sampleActions.some((action) => a.requiresApproval(action));
  });
}

export async function integrationHealth(companyId?: string) {
  return Promise.all(
    adapters.map(async (adapter) => ({
      name: adapter.name,
      scopes: adapter.scopes,
      status: await adapter.healthCheck(companyId),
      estimatedCostCents: adapter.estimateCost()
    }))
  );
}

export type ToolExecutionPolicy = {
  dryRun?: boolean;
  maxAttempts?: number;
  allowedActions?: string[];
};

export async function executeToolWithPolicy(
  adapter: ToolAdapter,
  action: string,
  payload: Record<string, unknown>,
  policy: ToolExecutionPolicy = {}
): Promise<ToolCallRecord> {
  if (policy.allowedActions && !policy.allowedActions.includes(action)) {
    return { adapter: adapter.name, action, status: "failed", summary: `Action "${action}" is not allowed by the Plug permission matrix.` };
  }
  const unavailable = toolUnavailableResult(adapter, action);
  if (unavailable) return unavailable;
  if (policy.dryRun && adapter.dryRun) return adapter.dryRun(action, payload);

  const maxAttempts = policy.maxAttempts ?? 2;
  let last: ToolCallRecord | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await adapter.execute(action, payload);
    if (last.status !== "failed") return last;
  }
  const fallback = adapters.find((item) => item.name === adapter.fallbackAdapterName);
  if (fallback) return fallback.execute(action, payload);
  return last ?? { adapter: adapter.name, action, status: "failed", summary: "Tool execution failed before producing a result." };
}
