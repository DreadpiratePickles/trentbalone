import type {
  CheckboxQuestion,
  ConfirmQuestion,
  InputQuestion,
  PasswordQuestion,
  PromptPort,
  SelectQuestion,
} from "./ports.js";

type InquirerModule = Pick<typeof import("@inquirer/prompts"), "input" | "select" | "checkbox" | "confirm" | "password">;

export interface InquirerPromptsOptions {
  /** Where the prompts are drawn. Defaults to stdout; `--json` passes stderr so stdout stays one document. */
  output?: NodeJS.WritableStream;
  /** Test seam: the prompt module. Defaults to a lazy `import("@inquirer/prompts")`. */
  load?: () => Promise<InquirerModule>;
}

/**
 * The real terminal adapter. `@inquirer/prompts` is imported lazily so that importing `@trent/core`
 * in a non-interactive process (a test, a `--json` run, the desktop app) never pulls in a TTY
 * dependency it will not use.
 *
 * Every question's pre-filled value is passed straight through to inquirer, so pressing enter keeps
 * the current setting.
 */
export class InquirerPrompts implements PromptPort {
  private module: InquirerModule | null = null;
  private readonly context: { output?: NodeJS.WritableStream };

  constructor(private readonly options: InquirerPromptsOptions = {}) {
    this.context = options.output === undefined ? {} : { output: options.output };
  }

  private async load(): Promise<InquirerModule> {
    if (!this.module) this.module = await (this.options.load ?? (() => import("@inquirer/prompts")))();
    return this.module;
  }

  async input(question: InputQuestion): Promise<string> {
    const { input } = await this.load();
    const answer = await input({ message: question.message, default: question.default }, this.context);
    return answer.trim() === "" ? question.default : answer.trim();
  }

  async select<T extends string>(question: SelectQuestion<T>): Promise<T> {
    const { select } = await this.load();
    return (await select(
      {
        message: question.message,
        choices: question.choices.map((c) => ({ name: c.name, value: c.value })),
        default: question.default,
      },
      this.context,
    )) as T;
  }

  async checkbox<T extends string>(question: CheckboxQuestion<T>): Promise<T[]> {
    const { checkbox } = await this.load();
    const preselected = new Set<string>(question.default);
    return (await checkbox(
      {
        message: question.message,
        choices: question.choices.map((c) => ({
          name: c.name,
          value: c.value,
          checked: preselected.has(c.value),
        })),
      },
      this.context,
    )) as T[];
  }

  async confirm(question: ConfirmQuestion): Promise<boolean> {
    const { confirm } = await this.load();
    return await confirm({ message: question.message, default: question.default }, this.context);
  }

  async password(question: PasswordQuestion): Promise<string> {
    const { password } = await this.load();
    // `mask` keeps the value off the screen; it is never echoed back afterwards either.
    return (await password({ message: question.message, mask: true }, this.context)).trim();
  }
}
