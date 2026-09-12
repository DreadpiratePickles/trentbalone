// OpenTelemetry Tracing Exporter for Trent Fleet
// Adheres to OpenTelemetry Semantic Conventions for Generative AI systems (gen_ai.*)

import { redactTranscript } from "../telemetry/redact.js";

export interface TraceStepInput {
  traceId: string;
  stepId: string;
  agentId: string;
  agentRole?: string;
  model: string;
  provider: string;
  prompt?: string;
  completion?: string;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
  cost?: number;
  durationMs?: number;
  toolCalls?: Array<{ name: string; args?: unknown }>;
  critiqueVerdict?: string;
}

export interface OTelSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number; // 1 = INTERNAL, 2 = SERVER, 3 = CLIENT
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  attributes: Record<string, string | number | boolean>;
}

export interface OTelExporterOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  fetchImpl?: typeof fetch;
}

export class OTelExporter {
  private endpoint: string;
  private headers: Record<string, string>;
  private serviceName: string;
  private fetchImpl: typeof fetch;
  private buffer: OTelSpan[] = [];

  constructor(options?: OTelExporterOptions) {
    this.endpoint = options?.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces";
    this.headers = options?.headers || {};
    this.serviceName = options?.serviceName || "trent-fleet";
    this.fetchImpl = options?.fetchImpl || (typeof fetch !== "undefined" ? fetch : (() => Promise.resolve({ ok: true, status: 200 } as any)));
  }

  /**
   * Delegates to the shared transcript redactor. This method used to carry its own regex pair,
   * which meant a secret shape fixed here still leaked from a session export and vice versa.
   * There is now exactly one definition, in `telemetry/redact.ts`, which itself keeps the error
   * layer's definition as a floor. Kept as a method so existing callers and tests are unaffected.
   */
  public redactSecrets(text: string): string {
    return redactTranscript(text);
  }

  public convertToSpan(input: TraceStepInput): OTelSpan {
    const now = Date.now();
    const duration = input.durationMs || 100;
    const startNano = (now - duration) * 1_000_000;
    const endNano = now * 1_000_000;

    const attributes: Record<string, string | number | boolean> = {
      "service.name": this.serviceName,
      "gen_ai.system": input.provider,
      "gen_ai.request.model": input.model,
      "gen_ai.agent.id": input.agentId,
    };

    if (input.agentRole) {
      attributes["gen_ai.agent.role"] = input.agentRole;
    }

    if (input.tokens) {
      attributes["gen_ai.usage.prompt_tokens"] = input.tokens.prompt;
      attributes["gen_ai.usage.completion_tokens"] = input.tokens.completion;
      attributes["gen_ai.usage.total_tokens"] = input.tokens.total;
    }

    if (input.cost !== undefined) {
      attributes["gen_ai.cost"] = input.cost;
    }

    if (input.critiqueVerdict) {
      attributes["gen_ai.critique.verdict"] = input.critiqueVerdict;
    }

    if (input.toolCalls) {
      attributes["gen_ai.tool_calls.count"] = input.toolCalls.length;
    }

    if (input.prompt) {
      attributes["gen_ai.prompt"] = this.redactSecrets(input.prompt);
    }

    if (input.completion) {
      attributes["gen_ai.completion"] = this.redactSecrets(input.completion);
    }

    return {
      traceId: input.traceId,
      spanId: input.stepId,
      name: "gen_ai.agent.turn",
      kind: 1, // INTERNAL
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      attributes,
    };
  }

  public record(input: TraceStepInput): void {
    const span = this.convertToSpan(input);
    this.buffer.push(span);
  }

  public getBufferedCount(): number {
    return this.buffer.length;
  }

  public async flush(): Promise<boolean> {
    if (this.buffer.length === 0) return true;

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: this.serviceName } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "trent.fleet.orchestrator" },
              spans: this.buffer,
            },
          ],
        },
      ],
    };

    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok || res.status < 400) {
        this.buffer = [];
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
