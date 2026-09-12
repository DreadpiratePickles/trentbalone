// Idempotency and Side-Effect Guardrail Manager for Trent Fleet
// Enforces single-execution invariants and dead-letter queues for external actions

export type ActionCategory = "payment" | "social_post" | "dns_mutation" | "github_pr" | "preview_deploy" | "generic";

export interface ActionRecord {
  idempotencyKey: string;
  category: ActionCategory;
  status: "in_flight" | "completed" | "failed" | "dead_letter";
  attempts: number;
  result?: unknown;
  error?: string;
  firstSeenAt: string;
  updatedAt: string;
}

export interface IdempotencyResult<T> {
  status: "completed" | "cached";
  result: T;
  cached?: boolean;
}

export class IdempotencyManager {
  private records = new Map<string, ActionRecord>();
  private deadLetterQueue: ActionRecord[] = [];

  private getRetryLimit(category: ActionCategory): number {
    switch (category) {
      case "payment":
      case "social_post":
      case "dns_mutation":
        return 1; // Strictly irreversible
      case "github_pr":
      case "preview_deploy":
        return 3;
      default:
        return 2;
    }
  }

  public async executeWithIdempotency<T>(
    idempotencyKey: string,
    category: ActionCategory,
    fn: () => Promise<T>
  ): Promise<IdempotencyResult<T>> {
    const existing = this.records.get(idempotencyKey);
    const limit = this.getRetryLimit(category);

    if (existing) {
      if (existing.status === "completed") {
        return {
          status: "completed",
          result: existing.result as T,
          cached: true,
        };
      }

      if (existing.status === "dead_letter" || existing.attempts >= limit) {
        throw new Error(
          `Action execution blocked: Max retry limit (${limit}) exceeded for irreversible action '${idempotencyKey}'. Check dead-letter queue.`
        );
      }

      existing.attempts++;
      existing.status = "in_flight";
      existing.updatedAt = new Date().toISOString();
    } else {
      this.records.set(idempotencyKey, {
        idempotencyKey,
        category,
        status: "in_flight",
        attempts: 1,
        firstSeenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const currentRecord = this.records.get(idempotencyKey)!;

    try {
      const res = await fn();
      currentRecord.status = "completed";
      currentRecord.result = res;
      currentRecord.updatedAt = new Date().toISOString();
      return {
        status: "completed",
        result: res,
        cached: false,
      };
    } catch (err: any) {
      currentRecord.error = err.message;
      currentRecord.updatedAt = new Date().toISOString();

      if (currentRecord.attempts >= limit) {
        currentRecord.status = "dead_letter";
        this.deadLetterQueue.push(currentRecord);
      } else {
        currentRecord.status = "failed";
      }

      throw err;
    }
  }

  public getDeadLetterQueue(): ActionRecord[] {
    return [...this.deadLetterQueue];
  }

  public clear(): void {
    this.records.clear();
    this.deadLetterQueue = [];
  }
}
