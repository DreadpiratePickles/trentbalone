import { z } from "zod";

/**
 * The `telemetry` config block. With no `otlp_endpoint` tracing is off: nothing is built and the
 * REPL banner says so. With one, every run's events become an OTLP/HTTP JSON trace tree
 * (`traces/bus-hook.ts`) posted to it. `service_name` is the `service.name` resource attribute.
 */
export const TelemetryConfigSchema = z.object({
  otlp_endpoint: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), { message: "otlp_endpoint must be http(s)" })
    .optional(),
  service_name: z.string().default("trent"),
});

export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;
