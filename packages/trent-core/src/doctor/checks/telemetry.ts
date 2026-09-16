import { probeHttp } from "../probe.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

/**
 * Whether the OTLP endpoint named in `telemetry.otlp_endpoint` answers. Unset is not a pass: the
 * line says "not configured" and the status is `skip`, so a report that shows tracing off never
 * reads as tracing verified. Set, the check posts an empty OTLP batch under the probe deadline;
 * a collector that answers at all, even with a 4xx for the empty batch, is reachable. Only a
 * network failure or a timeout is `fail`.
 */

const CATEGORY = "Telemetry";
const NAME = "OTel Trace Export";

/** An empty `ExportTraceServiceRequest`: valid OTLP/JSON that asks the collector to store nothing. */
const EMPTY_BATCH = JSON.stringify({ resourceSpans: [] });

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

export const checkTelemetry: DoctorCheck = {
  id: "check_telemetry",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const endpoint = ctx.configManager.loadConfig().telemetry.otlp_endpoint;
    if (!endpoint) {
      return result({
        status: "skip",
        message: "Tracing is not configured (telemetry.otlp_endpoint is unset); nothing was probed and nothing is exported.",
        details: { configured: false },
      });
    }

    const probe = await probeHttp(
      endpoint,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: EMPTY_BATCH },
      { ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }), ...(ctx.probeTimeoutMs === undefined ? {} : { timeoutMs: ctx.probeTimeoutMs }) },
    );

    if (probe.kind !== "response") {
      const why = probe.kind === "timeout" ? `timed out after ${ctx.probeTimeoutMs ?? 5000}ms` : "connection failed";
      return result({
        status: "fail",
        message: `OTLP endpoint ${endpoint} is unreachable: the empty-batch probe ${why}. Runs will trace to nowhere.`,
        fixHint: `Start the collector listening at ${endpoint}, or run \`trent config unset telemetry.otlp_endpoint\` to switch tracing off.`,
        details: { configured: true, endpoint, outcome: probe.kind },
      });
    }

    const httpStatus = probe.response.status;
    if (httpStatus === 404 || httpStatus === 405) {
      return result({
        status: "warn",
        message: `OTLP endpoint ${endpoint} is reachable but answered ${httpStatus} to a POST: the host is up, the traces path is not.`,
        fixHint: "Run `trent config set telemetry.otlp_endpoint <url>` with the collector's /v1/traces path.",
        details: { configured: true, endpoint, httpStatus },
      });
    }

    return result({
      status: "ok",
      message: `OTLP endpoint ${endpoint} is reachable (answered ${httpStatus} to an empty batch).`,
      details: { configured: true, endpoint, httpStatus },
    });
  },
};
