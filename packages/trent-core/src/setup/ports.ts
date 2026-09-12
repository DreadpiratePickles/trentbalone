/**
 * The wizard talks to the terminal only through these two ports.
 *
 * Nothing under `setup/` imports `@inquirer/prompts` at a call site: the real adapter lives in
 * `InquirerPrompts.ts` and a test drives the identical interface with `ScriptedPrompts`. That is what
 * makes the wizard runnable without a TTY.
 *
 * Note that `default` is REQUIRED on every question shape. A prompt with no pre-filled value is a
 * type error here and a thrown error in the scripted adapter, which is how "a returning user can press
 * enter through the whole wizard" is enforced rather than merely intended.
 */

export interface Question {
  /** Stable identifier. Scripted answers are keyed by this, never by call order. */
  id: string;
  message: string;
}

export interface Choice<T extends string> {
  name: string;
  value: T;
}

export interface InputQuestion extends Question {
  default: string;
}

export interface SelectQuestion<T extends string> extends Question {
  choices: ReadonlyArray<Choice<T>>;
  default: T;
}

export interface CheckboxQuestion<T extends string> extends Question {
  choices: ReadonlyArray<Choice<T>>;
  default: ReadonlyArray<T>;
}

export interface ConfirmQuestion extends Question {
  default: boolean;
}

/** A secret question. Its ANSWER is never returned to the output port, only to the caller. */
export type PasswordQuestion = Question;

export interface PromptPort {
  input(question: InputQuestion): Promise<string>;
  select<T extends string>(question: SelectQuestion<T>): Promise<T>;
  checkbox<T extends string>(question: CheckboxQuestion<T>): Promise<T[]>;
  confirm(question: ConfirmQuestion): Promise<boolean>;
  password(question: PasswordQuestion): Promise<string>;
}

export interface OutputPort {
  write(line: string): void;
}

/** Default output port. Plain lines, no colour, no emoji. */
export class ConsoleOutput implements OutputPort {
  write(line: string): void {
    process.stdout.write(`${line}\n`);
  }
}

/** Captures everything a user would have seen, so a test can assert on it. */
export class CollectingOutput implements OutputPort {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }
}
