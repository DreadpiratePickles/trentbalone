export type QuietHours = {
  startHour: number;
  endHour: number;
};

export function evaluateQuietHours(input: {
  now: string;
  timezone: "UTC";
  quietHours?: QuietHours;
  emergency?: boolean;
}): { allowed: true; deferUntil?: undefined } | { allowed: false; deferUntil: string } {
  if (!input.quietHours || input.emergency) return { allowed: true };

  const now = new Date(input.now);
  const hour = now.getUTCHours();
  const { startHour, endHour } = input.quietHours;
  const inside = startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;

  if (!inside) return { allowed: true };

  const deferred = new Date(now);
  deferred.setUTCHours(endHour, 0, 0, 0);
  if (hour >= startHour && startHour > endHour) {
    deferred.setUTCDate(deferred.getUTCDate() + 1);
  }
  return { allowed: false, deferUntil: deferred.toISOString() };
}
