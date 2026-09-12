import { TrentError } from "../errors/index.js";
import { EXIT } from "../errors/TrentError.js";
import type {
  CheckboxQuestion,
  ConfirmQuestion,
  InputQuestion,
  PasswordQuestion,
  PromptPort,
  SelectQuestion,
} from "./ports.js";

/**
 * A `PromptPort` that answers from a script instead of a terminal.
 *
 * Answers are keyed by question id, so a test states only what it wants to change. A question with
 * no scripted answer resolves to its pre-filled default — exactly what pressing enter does — which is
 * how the "run it twice, answer nothing the second time" test can prove that every prompt pre-fills.
 *
 * A question that arrives with no default at all throws, because that is a wizard bug: it would leave
 * a returning user unable to press enter through the step.
 */
export class ScriptedPrompts implements PromptPort {
  /** Every question shown, in order. Ids and messages only; never an answer. */
  readonly asked: Array<{ id: string; message: string }> = [];

  constructor(private readonly answers: Record<string, unknown> = {}) {}

  private record(question: { id: string; message: string }, hasDefault: boolean): void {
    this.asked.push({ id: question.id, message: question.message });
    if (!hasDefault) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "setup.prompt",
        message: `prompt "${question.id}" was shown without a pre-filled default`,
      });
    }
  }

  private answer(id: string): unknown {
    return Object.prototype.hasOwnProperty.call(this.answers, id) ? this.answers[id] : undefined;
  }

  async input(question: InputQuestion): Promise<string> {
    this.record(question, typeof question.default === "string");
    const scripted = this.answer(question.id);
    return scripted === undefined ? question.default : String(scripted);
  }

  async select<T extends string>(question: SelectQuestion<T>): Promise<T> {
    const valid = question.choices.some((c) => c.value === question.default);
    this.record(question, valid);
    const scripted = this.answer(question.id);
    return scripted === undefined ? question.default : (String(scripted) as T);
  }

  async checkbox<T extends string>(question: CheckboxQuestion<T>): Promise<T[]> {
    this.record(question, Array.isArray(question.default));
    const scripted = this.answer(question.id);
    if (scripted === undefined) return [...question.default];
    if (!Array.isArray(scripted)) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "setup.prompt",
        message: `scripted answer for "${question.id}" must be an array`,
      });
    }
    return scripted.map((v) => String(v) as T);
  }

  async confirm(question: ConfirmQuestion): Promise<boolean> {
    this.record(question, typeof question.default === "boolean");
    const scripted = this.answer(question.id);
    return scripted === undefined ? question.default : Boolean(scripted);
  }

  /**
   * A password has no default by design — there is nothing safe to pre-fill with — so it is the one
   * question the default check does not apply to. An unscripted password answers as an empty string,
   * which callers treat as "not provided".
   */
  async password(question: PasswordQuestion): Promise<string> {
    this.asked.push({ id: question.id, message: question.message });
    const scripted = this.answer(question.id);
    return scripted === undefined ? "" : String(scripted);
  }
}
