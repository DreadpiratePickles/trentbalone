import type { TrentConfig } from "../config/schema.js";
import type { SetupContext, SetupIncompleteReason, SetupMode, SetupResult } from "./types.js";

/** Shared plumbing for the three modes: line capture, secret writing, result shaping. */
export abstract class SetupRun {
  protected readonly lines: string[] = [];
  protected readonly secretsConfigured: string[] = [];

  constructor(protected readonly ctx: SetupContext) {}

  /** Show a line to the user and remember it, so a caller (and a test) can inspect the transcript. */
  protected say(line: string): void {
    this.lines.push(line);
    this.ctx.output.write(line);
  }

  protected blank(): void {
    this.say("");
  }

  /**
   * Persist a credential to the profile `.env` only. The value is passed straight to the config
   * manager and never enters a log line, a message, or `config.yaml`.
   */
  protected saveSecret(name: string, value: string): void {
    if (value.trim() === "") return;
    this.ctx.configManager.saveSecrets({ [name]: value.trim() });
    if (!this.secretsConfigured.includes(name)) this.secretsConfigured.push(name);
    this.say(`Stored ${name} in ${this.ctx.configManager.getSecretsPath()} (value not shown).`);
  }

  protected async doctor(): Promise<void> {
    if (!this.ctx.runDoctor) return;
    const report = await this.ctx.runDoctor();
    this.say(`Doctor: ${report.ok ? "pass" : "attention needed"} - ${report.summary}`);
  }

  protected ok(mode: SetupMode, message: string, config: TrentConfig): SetupResult {
    this.say(message);
    return {
      mode,
      success: true,
      message,
      config,
      secretsConfigured: [...this.secretsConfigured],
      output: [...this.lines],
    };
  }

  /**
   * A run that did not complete. The verdict is the caller's to print (the CLI prints
   * `Setup did not complete: <message>`), so it is returned rather than said: said here as well, the
   * reason reached the terminal twice.
   */
  protected abort(mode: SetupMode, message: string, reason: SetupIncompleteReason): SetupResult {
    return {
      mode,
      success: false,
      message,
      reason,
      config: null,
      secretsConfigured: [...this.secretsConfigured],
      output: [...this.lines],
    };
  }
}
