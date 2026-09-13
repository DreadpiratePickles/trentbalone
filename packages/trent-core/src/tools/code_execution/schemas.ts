/**
 * Hermes's `execute_code` schema (`tools/code_execution_tool.py:861-876`): `code` required,
 * `reset` optional. Trent adds `language` (Hermes is Python-only; the seats also write Node) and
 * `timeout` (Hermes hard-codes five minutes). There is no persistent kernel here: every call is
 * a fresh interpreter in the sandbox, so `reset` is accepted and has nothing to discard.
 */
import type { ToolSchema } from "../web/schemas.js";

export const CODE_LANGUAGES = ["python", "javascript"] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** Hermes: "5-minute timeout". */
export const CODE_DEFAULT_TIMEOUT_S = 300;
export const CODE_MAX_TIMEOUT_S = 600;

export const CODE_EXECUTION_SCHEMAS: ToolSchema[] = [
  {
    name: "execute_code",
    description:
      "Run a Python or JavaScript snippet in the isolated sandbox (the repository at the workspace " +
      "root, no network, no host secrets). Use it when a shell one-liner is not enough: filtering or " +
      "reducing large outputs before they enter context, branching, loops over files. Print the final " +
      "result to stdout. Each call is a fresh interpreter; nothing persists between calls. Stdout over " +
      "the summary limit is head/tail truncated inline and the full text is saved to a file whose path " +
      "rides in the result. Same approval floor as terminal: hardline patterns never run, dangerous " +
      "ones need approval.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Source code to execute. Print your final result to stdout." },
        language: {
          type: "string",
          enum: [...CODE_LANGUAGES],
          description: "Interpreter: python (python3) or javascript (node). Default python.",
        },
        timeout: {
          type: "integer",
          description: `Seconds before the snippet is killed (1-${CODE_MAX_TIMEOUT_S}, default ${CODE_DEFAULT_TIMEOUT_S}).`,
        },
        reset: {
          type: "boolean",
          description: "Accepted for Hermes compatibility. Every call already starts fresh; there is no kernel state to discard.",
        },
      },
      required: ["code"],
    },
  },
];
