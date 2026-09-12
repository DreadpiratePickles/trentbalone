/**
 * `@trent/core` wrapper over `apps/web/lib/readiness-controls.ts`.
 *
 * Pure static data — 35 production-readiness controls and a slug lookup — with
 * no runtime dependencies. Thin typed re-export with locally declared types.
 *
 * Wraps: apps/web/lib/readiness-controls.ts
 */

import {
  READINESS_CONTROLS as LIB_READINESS_CONTROLS,
  REQUIRED_READINESS_CONTROL_SLUGS as LIB_REQUIRED_SLUGS,
  readinessControlBySlug as libReadinessControlBySlug,
} from "@/lib/readiness-controls";

/**
 * Note (Stage 00 audit): the app declares a `"proof_required"` arm that no
 * control currently uses. It is kept in the union so the wrapper stays
 * assignment-compatible with the app rather than silently narrowing it.
 */
export type ReadinessControlStatus =
  | "enforced"
  | "partial"
  | "external_required"
  | "proof_required";

export type ReadinessControlCategory =
  | "security"
  | "privacy"
  | "testing"
  | "reliability"
  | "governance"
  | "architecture";

export type ReadinessControl = {
  slug: string;
  label: string;
  category: ReadinessControlCategory;
  status: ReadinessControlStatus;
  why: string;
  evidence: string[];
  nextAction: string;
};

/** Every control slug a release must account for. */
export const REQUIRED_READINESS_CONTROL_SLUGS: readonly string[] = LIB_REQUIRED_SLUGS;

/** The full control registry, each entry carrying its evidence and next action. */
export const READINESS_CONTROLS: readonly ReadinessControl[] =
  LIB_READINESS_CONTROLS as unknown as readonly ReadinessControl[];

/** Look one control up by slug; undefined when the slug is unknown. */
export function readinessControlBySlug(slug: string): ReadinessControl | undefined {
  return libReadinessControlBySlug(slug) as ReadinessControl | undefined;
}

/** Controls grouped by category, in registry order. */
export function readinessControlsByCategory(): Record<ReadinessControlCategory, ReadinessControl[]> {
  const grouped = {} as Record<ReadinessControlCategory, ReadinessControl[]>;
  for (const control of READINESS_CONTROLS) {
    (grouped[control.category] ??= []).push(control);
  }
  return grouped;
}
