/**
 * The social line (B1): which social providers `trent connect` holds (by name, from the profile
 * secrets file through `ConnectStore.read`, which carries no value), which platforms that
 * reaches and by which route, the review each platform still needs, and whether the `social`
 * toolset is enabled at all. The matrix is the toolset's own (`tools/social/matrix.ts`), so the
 * doctor reports what `social_post` would do, not what a page claims. No network.
 */
import { ConnectStore } from "../../connect/store.js";
import type { ConnectProviderId } from "../../connect/providers.js";
import { platformEntry, type PlatformEntry } from "../../tools/social/matrix.js";
import { SOCIAL_TOOL_PLATFORMS } from "../../tools/social/schemas.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

const CATEGORY = "Social";
const NAME = "Social Platforms";
/** The providers the social toolset publishes through; the rest of the registry is other toolsets'. */
export const SOCIAL_PROVIDERS: readonly ConnectProviderId[] = ["meta", "google", "bluesky", "buffer"];
const CONNECT_HINT = "run trent connect meta (Facebook and Instagram), trent connect bluesky, or trent connect buffer (any platform Buffer holds a channel for); google covers YouTube replies and insights";

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

function describe(entry: PlatformEntry): Record<string, unknown> {
  return {
    platform: entry.platform,
    ...(entry.provider === undefined ? {} : { provider: entry.provider }),
    connected: entry.connected,
    ...(entry.postRoute === undefined ? {} : { route: entry.postRoute }),
    direct: entry.direct,
    review: entry.review,
    caveats: entry.caveats,
  };
}

export const checkSocial: DoctorCheck = {
  id: "check_social",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const store = new ConnectStore(ctx.configManager);
    const connected = SOCIAL_PROVIDERS.filter((id) => store.read(id).connected);
    const config = ctx.configManager.loadConfig();
    const toolsetEnabled = config.toolsets.includes("social") && !config.disabled_toolsets.includes("social");
    const entries = SOCIAL_TOOL_PLATFORMS.map((platform) => platformEntry(platform, new Set(connected)));
    const reachable = entries.filter((entry) => entry.postRoute !== undefined);
    const details = { connected, toolsetEnabled, platforms: entries.map(describe) };

    if (connected.length === 0) {
      return result({
        status: "skip",
        message: "No social provider is connected, so the social toolset can list the matrix but publish nowhere.",
        fixHint: `${CONNECT_HINT}; then add social to toolsets in config.yaml (docs/social.md).`,
        details,
      });
    }
    const routes = reachable.map((entry) => `${entry.platform} via ${entry.postRoute}`).join(", ") || "no platform";
    const pending = entries
      .filter((entry) => entry.postRoute === undefined)
      .map((entry) => `${entry.platform} (${entry.review})`)
      .join(", ");
    const message = `Connected: ${connected.join(", ")}. Posts reach ${routes}.${pending === "" ? "" : ` Not reachable yet: ${pending}.`}`;
    if (!toolsetEnabled) {
      return result({
        status: "warn",
        message: `${message} The social toolset is not enabled, so no seat can use it.`,
        fixHint: "add social to toolsets (and remove it from disabled_toolsets) in config.yaml; docs/social.md lists the review each platform needs",
        details,
      });
    }
    return result({ status: "ok", message, details });
  },
};
