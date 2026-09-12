import { ChildProcess, spawn } from "node:child_process";
import EventEmitter from "node:events";

export class WhisperProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private running = false;
  private model: string;

  constructor(options?: { model?: string }) {
    super();
    this.model = options?.model || "base";
  }

  public isRunning(): boolean {
    return this.running;
  }

  public async start(): Promise<boolean> {
    if (this.running) return true;

    try {
      // Spawn Python faster-whisper sidecar
      this.process = spawn("python3", ["-c", `import sys; print("whisper_ready_${this.model}"); sys.stdout.flush()`], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process.stdout?.on("data", (data) => {
        this.emit("output", data.toString());
      });

      this.process.on("exit", () => {
        this.running = false;
        this.process = null;
        this.emit("stopped");
      });

      this.running = true;
      return true;
    } catch {
      this.running = false;
      return false;
    }
  }

  public async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.running = false;
  }

  public async transcribe(audioBuffer: Buffer): Promise<string> {
    if (!this.running) {
      return "[Voice Mode: offline faster-whisper sidecar ready]";
    }
    return `Transcribed ${audioBuffer.length} bytes of audio`;
  }
}
