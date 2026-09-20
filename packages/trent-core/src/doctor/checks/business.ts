/**
 * The business line of `trent doctor` (B3-core): one line per provider the business toolset
 * executes against — Stripe, Google Calendar, Square, Twilio — connected or not, with the
 * `trent connect <provider>` command for each one that is not. Built from `ConnectStore.read`,
 * which returns names and metadata only, so no token can reach this report even by mistake.
 */
import { connectDoctorLines } from "../../connect/doctor.js";
import { ConnectStore } from "../../connect/store.js";
import { BUSINESS_HOSTS, BUSINESS_PROVIDERS } from "../../tools/business/http.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

export { BUSINESS_PROVIDERS } from "../../tools/business/http.js";

const CATEGORY = "Business";
const NAME = "Business Providers";

export const checkBusiness: DoctorCheck = {
  id: "check_business",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const store = new ConnectStore(ctx.configManager);
    const lines = connectDoctorLines(store).filter((line) => (BUSINESS_PROVIDERS as readonly string[]).includes(line.provider));
    const byProvider = new Map(lines.map((line) => [line.provider, line]));
    const rows = BUSINESS_PROVIDERS.map((provider) => {
      const line = byProvider.get(provider);
      const state = line === undefined ? "not connected" : line.message.replace(/^[^:]*:\s*/, "");
      return `${provider}: ${state}`;
    });
    const connected = BUSINESS_PROVIDERS.filter((provider) => byProvider.get(provider)?.status === "ok");
    const expired = BUSINESS_PROVIDERS.filter((provider) => byProvider.get(provider)?.status === "warn");
    const missing = BUSINESS_PROVIDERS.filter((provider) => !connected.includes(provider) && !expired.includes(provider));
    const fixes = BUSINESS_PROVIDERS.filter((provider) => !connected.includes(provider)).map((provider) => byProvider.get(provider)?.fixHint ?? `trent connect ${provider}`);
    const enabled = ctx.configManager.loadConfig().toolsets.includes("business");
    const details = { connected, expired, missing, toolsetEnabled: enabled, hosts: BUSINESS_HOSTS };
    const status: CheckResult["status"] = connected.length === 0 && expired.length === 0 ? "skip" : expired.length > 0 ? "warn" : "ok";
    const fixHint = fixes.length === 0 ? undefined : `${fixes.join("; ")}${enabled ? "" : "; then add business to toolsets in config.yaml (docs/business.md)"}`;
    return { category: CATEGORY, name: NAME, status, message: rows.join("\n"), ...(fixHint === undefined ? {} : { fixHint }), details };
  },
};
