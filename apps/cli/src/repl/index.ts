import readline from "node:readline";
import chalk from "chalk";
import {
  ConfigManager,
  FleetManager,
  SkillsHub,
  PersonalityManager,
  VoiceManager,
  SessionManager,
  DoctorRunner,
} from "@trent/core";
import { formatBanner, formatAgentMessage, getRoleColor } from "./output.js";
import { SLASH_COMMANDS, type SlashCommandContext } from "../slash/index.js";

export interface ReplOptions {
  continueSession?: boolean;
  profile?: string;
}

export class ClassicRepl {
  private configManager: ConfigManager;
  private fleetManager: FleetManager;
  private skillsHub: SkillsHub;
  private personalityManager: PersonalityManager;
  private voiceManager: VoiceManager;
  private sessionManager: SessionManager;
  private doctorRunner: DoctorRunner;
  private rl: readline.Interface | null = null;
  private activeAgent = "ceo";

  constructor(options?: ReplOptions) {
    this.configManager = new ConfigManager({ profile: options?.profile });
    this.fleetManager = new FleetManager(this.configManager);
    this.skillsHub = new SkillsHub(this.configManager);
    this.personalityManager = new PersonalityManager(this.configManager);
    this.voiceManager = new VoiceManager(this.configManager);
    this.sessionManager = new SessionManager(this.configManager);
    this.doctorRunner = new DoctorRunner(this.configManager);

    if (options?.continueSession) {
      this.sessionManager.resumeLastSession();
    }
  }

  public async start(): Promise<void> {
    const config = this.configManager.loadConfig();
    const activeAgents = config.fleet.active_agents || ["ceo"];
    this.activeAgent = config.fleet.default_agent || "ceo";

    // Resume or start new session
    let session = this.sessionManager.getCurrentSession();
    if (!session) {
      session = this.sessionManager.startSession(this.activeAgent, config.model, config.provider);
    }

    // Print banner
    console.log(formatBanner(activeAgents.length, config.model, config.provider));

    if (session.messages.length > 0) {
      console.log(chalk.dim(`Resumed session: "${session.title}" (${session.messages.length} messages)\n`));
      for (const m of session.messages.slice(-6)) {
        if (m.role === "user") {
          console.log(`${chalk.bold("you>")} ${m.content}`);
        } else {
          console.log(formatAgentMessage(m.agent || this.activeAgent, m.content, m.metadata));
        }
      }
      console.log("");
    }

    this.setupReadline();
  }

  private setupReadline(): void {
    const slashList = Object.keys(SLASH_COMMANDS).map((s) => `/${s}`);

    const completer = (line: string) => {
      const hits = slashList.filter((c) => c.startsWith(line));
      return [hits.length ? hits : slashList, line];
    };

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer,
      prompt: chalk.hex("#8B5CF6")("trent> "),
    });

    this.rl.prompt();

    this.rl.on("line", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        this.rl?.prompt();
        return;
      }

      // Slash command execution
      if (trimmed.startsWith("/")) {
        const parts = trimmed.slice(1).split(/\s+/);
        const cmdName = parts[0].toLowerCase();
        const cmdArgs = parts.slice(1);

        const command = SLASH_COMMANDS[cmdName];
        if (command) {
          try {
            const ctx: SlashCommandContext = {
              configManager: this.configManager,
              fleetManager: this.fleetManager,
              skillsHub: this.skillsHub,
              personalityManager: this.personalityManager,
              voiceManager: this.voiceManager,
              sessionManager: this.sessionManager,
              doctorRunner: this.doctorRunner,
            };
            const output = await command.execute(cmdArgs, ctx);
            console.log(output);
          } catch (err: any) {
            console.log(chalk.red(`Error executing /${cmdName}: ${err.message}`));
          }
        } else {
          console.log(chalk.yellow(`Unknown command: /${cmdName}. Type /help for available commands.`));
        }

        this.rl?.prompt();
        return;
      }

      // Regular chat turn with active agent
      const session = this.sessionManager.getCurrentSession()!;
      this.sessionManager.appendMessage(session.id, {
        role: "user",
        content: trimmed,
      });

      const roleColor = getRoleColor(this.activeAgent);
      console.log(chalk.dim(`[${this.activeAgent}] Thinking...`));

      const startTime = Date.now();
      const personality = this.personalityManager.getActivePersonality();

      // Deterministic autonomous cofounder reasoning response
      const reply = this.generateAutonomousReply(trimmed, personality.name);
      const durationMs = Date.now() - startTime + 350;
      const cost = 0.04;

      this.sessionManager.appendMessage(session.id, {
        role: "assistant",
        agent: this.activeAgent,
        content: reply,
        metadata: {
          cost,
          durationMs,
          model: this.configManager.loadConfig().model,
        },
      });

      console.log(
        formatAgentMessage(this.activeAgent, reply, {
          durationMs,
          cost,
          model: this.configManager.loadConfig().model,
        })
      );
      console.log("");

      this.rl?.prompt();
    });

    this.rl.on("close", () => {
      console.log(chalk.dim("\nSession saved. Goodbye!"));
      process.exit(0);
    });
  }

  private generateAutonomousReply(input: string, personalityName: string): string {
    const isPirate = personalityName === "pirate";
    const isRobot = personalityName === "robot";

    if (isPirate) {
      return `Ahoy matey! I've charted our course regarding: "${input}". The fleet stands ready at the helm to execute.`;
    }
    if (isRobot) {
      return `INPUT_ACKNOWLEDGED: "${input}". Processing DAG subtask allocation. Execution status: NOMINAL.`;
    }

    return `I've analyzed: "${input}".\n\n1. Prioritization: High leverage on current milestone.\n2. Action Plan: Deploying engineering agents to inspect requirements and verify state.\n3. Next Step: Continuing execution under active budget cap.`;
  }
}
