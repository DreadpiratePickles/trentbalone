/** Shared scorecard helpers for workbench and orchestration eval suites. */

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function passRate(passed: number, total: number): number {
  if (total === 0) return 0;
  return roundMetric(passed / total);
}

export function roundMetric(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
