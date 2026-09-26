/**
 * [H3] `{{payload.a.b}}` substitution from a delivery's JSON body. The config schema has already
 * refused any reference outside `payload` and any prototype segment
 * (`config/sections/gateway.ts` badWebhookTemplateRefs); here a path is walked over OWN properties
 * only, an array by its numeric index, and a missing value renders as nothing. A string renders as
 * itself, an object or array as JSON, and each value is clipped so one field cannot swamp the run.
 */
export const MAX_VALUE_CHARS = 2000;
export const MAX_RENDERED_CHARS = 16_000;
const CLIPPED = " [clipped]";
const REF = /\{\{\s*([^{}]*?)\s*\}\}/g;

function lookup(payload: unknown, ref: string): unknown {
  const segments = ref.split(".").slice(1);
  let current: unknown = payload;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}${CLIPPED}`;
}

function render(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return JSON.stringify(value) ?? "";
}

export function renderWebhookTemplate(template: string, payload: unknown): string {
  const rendered = template.replace(REF, (_match, ref: string) => (ref.startsWith("payload") ? clip(render(lookup(payload, ref)), MAX_VALUE_CHARS) : ""));
  return clip(rendered, MAX_RENDERED_CHARS);
}
