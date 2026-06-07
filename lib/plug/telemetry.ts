export type PlugRunTelemetry = {
  plugId: string;
  companyId: string;
  success: boolean;
  costCents: number;
  durationMs: number;
  failureTags: string[];
};

export function recordPlugRunTelemetry(existing: PlugRunTelemetry[], event: PlugRunTelemetry) {
  return [...existing, event];
}
