import { buildClaudeAdsCommandPlan, buildClaudeAdsToolScopes, formatClaudeAdsCommand } from "@/lib/claude-ads";
import {
  buildHyperFramesCommandPlan,
  buildHyperFramesToolScopes,
  executeHyperFramesCommand,
  formatHyperFramesCommand,
  getHyperFramesConfig,
  type HyperFramesAction,
} from "@/lib/hyperframes";
import {
  buildOpenGenerativeAiCommandPlan,
  buildOpenGenerativeAiToolScopes,
  formatOpenGenerativeAiCommand,
  isOpenGenerativeAiAction,
} from "@/lib/open-generative-ai";
import { toolUnavailableResult } from "@/lib/provider-readiness";
import type { ToolAdapter } from "@/lib/tools";
import { createWorkbenchSandboxToolAdapter } from "@/lib/workbench-sandbox-tool-adapter";

function isHyperFramesAction(action: string): action is HyperFramesAction {
  return ["create", "catalog", "preview", "lint", "inspect", "render"].includes(action);
}

export const sandboxToolAdapters: ToolAdapter[] = [
  createWorkbenchSandboxToolAdapter(),
  {
    name: "HyperFrames",
    scopes: buildHyperFramesToolScopes(),
    availability: getHyperFramesConfig().executionEnabled ? "real" : "test_only",
    async healthCheck() {
      return getHyperFramesConfig().executionEnabled ? "connected" : "mocked";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return ["publish", "upload", "external", "post", "ads.launch"].some((word) =>
        action.toLowerCase().includes(word),
      );
    },
    async execute(action, payload) {
      const unavailable = toolUnavailableResult(this, action);
      if (unavailable) return unavailable;
      if (this.requiresApproval(action)) {
        return {
          adapter: "HyperFrames",
          action,
          status: "needs_approval",
          summary: `HyperFrames action "${action}" requires approval before Trent publishes, uploads, posts, or launches externally.`,
        };
      }

      if (!isHyperFramesAction(action)) {
        return { adapter: "HyperFrames", action, status: "failed", summary: `Unsupported HyperFrames action "${action}".` };
      }

      const config = getHyperFramesConfig();
      const command = formatHyperFramesCommand(buildHyperFramesCommandPlan(action, payload));
      if (!config.executionEnabled) {
        return { adapter: "HyperFrames", action, status: "mocked", summary: `HyperFrames execution is disabled. Trent would run: ${command}` };
      }

      try {
        const result = await executeHyperFramesCommand(action, payload, config);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 1200);
        return {
          adapter: "HyperFrames",
          action,
          status: "completed",
          summary: `HyperFrames completed: ${result.command}${output ? `\n${output}` : ""}`,
        };
      } catch (err: unknown) {
        return { adapter: "HyperFrames", action, status: "failed", summary: (err as Error).message };
      }
    },
    async dryRun(action, payload) {
      const unavailable = toolUnavailableResult(this, action);
      if (unavailable) return unavailable;
      if (!isHyperFramesAction(action)) {
        return { adapter: "HyperFrames", action, status: "failed", summary: `Unsupported HyperFrames action "${action}".` };
      }
      return {
        adapter: "HyperFrames",
        action,
        status: this.requiresApproval(action) ? "needs_approval" : "mocked",
        summary: `HyperFrames dry-run: ${formatHyperFramesCommand(buildHyperFramesCommandPlan(action, payload))}`,
      };
    },
  },
  {
    name: "Claude Ads",
    scopes: buildClaudeAdsToolScopes(),
    availability: "test_only",
    async healthCheck() {
      return "mocked";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return ["launch", "publish", "spend", "pause", "budget change", "bid change", "upload", "edit live"].some((word) =>
        action.toLowerCase().includes(word),
      );
    },
    async execute(action, payload) {
      const unavailable = toolUnavailableResult(this, action);
      if (unavailable) return unavailable;
      if (this.requiresApproval(action)) {
        return {
          adapter: "Claude Ads",
          action,
          status: "needs_approval",
          summary: `Claude Ads action "${action}" requires approval before Trent changes live campaigns, spend, bids, or published ads.`,
        };
      }

      const command = formatClaudeAdsCommand(buildClaudeAdsCommandPlan(action, {
        platform: typeof payload.platform === "string" ? payload.platform : undefined,
        businessType: typeof payload.businessType === "string" ? payload.businessType : undefined,
        output: typeof payload.output === "string" ? payload.output : undefined,
      }));

      return {
        adapter: "Claude Ads",
        action,
        status: "mocked",
        summary: `Claude Ads critic plan: ${command}. Trent records the audit/review intent without touching live ad platforms.`,
      };
    },
    async dryRun(action, payload) {
      const unavailable = toolUnavailableResult(this, action);
      if (unavailable) return unavailable;
      const command = formatClaudeAdsCommand(buildClaudeAdsCommandPlan(action, {
        platform: typeof payload.platform === "string" ? payload.platform : undefined,
        businessType: typeof payload.businessType === "string" ? payload.businessType : undefined,
        output: typeof payload.output === "string" ? payload.output : undefined,
      }));
      return {
        adapter: "Claude Ads",
        action,
        status: this.requiresApproval(action) ? "needs_approval" : "mocked",
        summary: `Claude Ads dry-run: ${command}`,
      };
    },
  },
  {
    name: "Open Generative AI",
    scopes: buildOpenGenerativeAiToolScopes(),
    availability: "test_only",
    async healthCheck() {
      return "mocked";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return ["publish", "post", "ads", "ad launch", "launch ad", "external", "upload private", "brand-unsafe", "policy-sensitive"].some((word) =>
        action.toLowerCase().includes(word),
      );
    },
    async execute(action, payload) {
      const unavailable = toolUnavailableResult(this, action);
      if (unavailable) return unavailable;
      if (this.requiresApproval(action)) {
        return {
          adapter: "Open Generative AI",
          action,
          status: "needs_approval",
          summary: `Open Generative AI action "${action}" requires approval before publishing, launching ads, external upload, or sensitive creative work.`,
        };
      }
      if (!isOpenGenerativeAiAction(action)) {
        return { adapter: "Open Generative AI", action, status: "failed", summary: `Unsupported Open Generative AI action "${action}".` };
      }
      return {
        adapter: "Open Generative AI",
        action,
        status: "mocked",
        summary: `Open Generative AI sandbox plan: ${formatOpenGenerativeAiCommand(buildOpenGenerativeAiCommandPlan(action, payload))}`,
      };
    },
    async dryRun(action, payload) {
      const unavailable = toolUnavailableResult(this, action);
      if (unavailable) return unavailable;
      if (!isOpenGenerativeAiAction(action)) {
        return { adapter: "Open Generative AI", action, status: "failed", summary: `Unsupported Open Generative AI action "${action}".` };
      }
      return {
        adapter: "Open Generative AI",
        action,
        status: this.requiresApproval(action) ? "needs_approval" : "mocked",
        summary: `Open Generative AI dry-run: ${formatOpenGenerativeAiCommand(buildOpenGenerativeAiCommandPlan(action, payload))}`,
      };
    },
  },
];
