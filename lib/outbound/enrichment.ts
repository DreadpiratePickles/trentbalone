export type EnrichedContact = Record<string, unknown> & {
  source?: string;
  title?: string;
  linkedinUrl?: string;
};

export function mergeEnrichment(input: { existing: EnrichedContact; enriched: EnrichedContact }): EnrichedContact & {
  enrichmentSource?: string;
} {
  return {
    ...input.enriched,
    ...input.existing,
    enrichmentSource: input.enriched.source,
  };
}
