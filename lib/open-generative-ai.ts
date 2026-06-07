export const OPEN_GENERATIVE_AI_SCOPES = [
  "open_gen_ai:launch_sandbox",
  "open_gen_ai:image_generate",
  "open_gen_ai:video_generate",
  "open_gen_ai:lip_sync",
  "open_gen_ai:cinema_workflow",
  "open_gen_ai:asset_export",
];

export type OpenGenerativeAiAction =
  | "launch_sandbox"
  | "image_generate"
  | "video_generate"
  | "lip_sync"
  | "cinema_workflow"
  | "asset_export";

export function buildOpenGenerativeAiToolScopes() {
  return [...OPEN_GENERATIVE_AI_SCOPES];
}

export function isOpenGenerativeAiAction(action: string): action is OpenGenerativeAiAction {
  return [
    "launch_sandbox",
    "image_generate",
    "video_generate",
    "lip_sync",
    "cinema_workflow",
    "asset_export",
  ].includes(action);
}

export function buildOpenGenerativeAiCommandPlan(action: OpenGenerativeAiAction, payload: Record<string, unknown>) {
  const args = ["open-generative-ai", "--sandbox", action.replaceAll("_", "-")];

  const prompt = typeof payload.prompt === "string" ? payload.prompt : undefined;
  if (prompt) args.push("--prompt", prompt);

  const model = typeof payload.model === "string" ? payload.model : undefined;
  if (model) args.push("--model", model);

  const input = typeof payload.input === "string" ? payload.input : undefined;
  if (input) args.push("--input", input);

  const output = typeof payload.output === "string" ? payload.output : undefined;
  if (output) args.push("--output", output);

  return {
    command: args[0],
    args: args.slice(1),
    sandbox: true,
  };
}

export function formatOpenGenerativeAiCommand(plan: ReturnType<typeof buildOpenGenerativeAiCommandPlan>) {
  return [plan.command, ...plan.args].join(" ");
}
