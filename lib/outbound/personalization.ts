export function buildPersonalizationBrief(input: {
  name: string;
  company: string;
  role: string;
  signals: string[];
  painPoints: string[];
}) {
  return {
    openingLine: `${input.name}, noticed ${input.company} is ${input.signals[0] ?? "showing strong growth signals"}.`,
    persona: `${input.role} at ${input.company}`,
    talkingPoints: [...input.signals, ...input.painPoints],
  };
}
