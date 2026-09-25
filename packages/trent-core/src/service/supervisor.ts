/**
 * The supervisor behind `trent service daemon`: an ordered set of components (the messaging
 * gateway, the cron runner, the heartbeat loop) started in order and stopped in reverse, one log
 * line for each start and each stop.
 *
 * A component that cannot start is expected to have released whatever it took before it throws
 * (the gateway manager's lock, a runner's pid file); the supervisor then stops every component
 * already started, newest first, and re-throws, so the process exits non-zero with nothing left
 * holding a lock. A stop that throws is logged and the remaining components still stop.
 *
 * It knows nothing about what the components are: the CLI builds them over one headless runtime
 * (apps/cli/src/commands/groups/service-daemon.ts), and a test builds them from plain objects.
 */

export interface ServiceComponent {
  readonly name: string;
  /** Starts it; a returned string is carried on the start line (`gateway started: telegram`). */
  start(): Promise<string | undefined> | string | undefined;
  stop(): Promise<void> | void;
}

/** A component the configuration leaves off (`heartbeat.enabled: false`): reported, never started. */
export interface SkippedComponent {
  readonly name: string;
  /** Why it is off, carried on its line: `heartbeat skipped: heartbeat.enabled is false`. */
  readonly skipped: string;
}

export type ServiceEntry = ServiceComponent | SkippedComponent;

export interface ServiceComponentReport {
  readonly name: string;
  readonly state: "started" | "skipped";
  readonly detail?: string;
}

export interface ServiceSupervisorOptions {
  /** In start order; a skipped entry keeps its place in the report and the log. */
  readonly components: readonly ServiceEntry[];
  readonly log: (line: string) => void;
}

function isSkipped(entry: ServiceEntry): entry is SkippedComponent {
  return typeof (entry as SkippedComponent).skipped === "string";
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ServiceSupervisor {
  private readonly options: ServiceSupervisorOptions;
  private started: ServiceComponent[] = [];
  private begun = false;

  constructor(options: ServiceSupervisorOptions) {
    this.options = options;
  }

  /** The names of the components now running, in start order. */
  public get running(): string[] {
    return this.started.map((component) => component.name);
  }

  /** Starts every component in order; the report lists every entry in that order. */
  public async start(): Promise<ServiceComponentReport[]> {
    if (this.begun) throw new Error("the service supervisor has already started");
    this.begun = true;
    const report: ServiceComponentReport[] = [];
    for (const entry of this.options.components) {
      if (isSkipped(entry)) {
        this.options.log(`${entry.name} skipped: ${entry.skipped}`);
        report.push({ name: entry.name, state: "skipped", detail: entry.skipped });
        continue;
      }
      let detail: string | undefined;
      try {
        detail = (await entry.start()) ?? undefined;
      } catch (error) {
        this.options.log(`${entry.name} failed to start: ${reason(error)}`);
        await this.stop();
        throw error;
      }
      this.started.push(entry);
      const said = detail === undefined || detail === "" ? undefined : detail;
      this.options.log(said === undefined ? `${entry.name} started` : `${entry.name} started: ${said}`);
      report.push({ name: entry.name, state: "started", ...(said === undefined ? {} : { detail: said }) });
    }
    return report;
  }

  /** Stops every started component, newest first. Idempotent. */
  public async stop(): Promise<void> {
    const stopping = this.started.reverse();
    this.started = [];
    for (const component of stopping) {
      try {
        await component.stop();
        this.options.log(`${component.name} stopped`);
      } catch (error) {
        this.options.log(`${component.name} failed to stop: ${reason(error)}`);
      }
    }
  }
}
