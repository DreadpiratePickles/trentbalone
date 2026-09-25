import { EXIT, TrentError } from "../errors/TrentError.js";
import type {
  CheckboxQuestion,
  ConfirmQuestion,
  InputQuestion,
  PasswordQuestion,
  PromptPort,
  Question,
  SelectQuestion,
} from "./ports.js";
import type { SetupMode } from "./types.js";

/**
 * Setup with nothing to answer its prompts: stdin is a pipe, a file or closed.
 *
 * Handing inquirer a stdin that is not a terminal ends in `User force closed the prompt with 0 null`
 * (or a hang on an open pipe). These say instead, in one line, what is missing and where to run it,
 * with exit 2, the code the other prompt-refusing commands use (`trent workspace trust`, `trent connect`).
 */

/** Full and blank-slate ask at least one question on every path, so they refuse before touching the profile. */
export function noTerminalForMode(mode: SetupMode): TrentError {
  return new TrentError({
    code: EXIT.USAGE,
    operation: `setup.${mode}`,
    message: `stdin is not a terminal, so nothing here can answer the ${mode} setup questions; run trent setup --mode ${mode} in a terminal`,
  });
}

/** The port a non-interactive quick run gets: its one confirmation refuses, by name. */
export class NoTerminalPrompts implements PromptPort {
  constructor(private readonly mode: SetupMode) {}

  private refuse(question: Question): never {
    throw new TrentError({
      code: EXIT.USAGE,
      operation: `setup.${this.mode}`,
      message: `stdin is not a terminal, so nothing here can answer "${question.message}"; run trent setup in a terminal`,
    });
  }

  async input(question: InputQuestion): Promise<string> {
    return this.refuse(question);
  }

  async select<T extends string>(question: SelectQuestion<T>): Promise<T> {
    return this.refuse(question);
  }

  async checkbox<T extends string>(question: CheckboxQuestion<T>): Promise<T[]> {
    return this.refuse(question);
  }

  async confirm(question: ConfirmQuestion): Promise<boolean> {
    return this.refuse(question);
  }

  async password(question: PasswordQuestion): Promise<string> {
    return this.refuse(question);
  }
}
