import { ConfigManager } from "../config/ConfigManager.js";
import { WhisperProcess } from "./WhisperProcess.js";

export class VoiceManager {
  private configManager: ConfigManager;
  private whisper: WhisperProcess;
  private enabled: boolean;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
    const config = this.configManager.loadConfig();
    this.enabled = Boolean(config.voice?.enabled);
    this.whisper = new WhisperProcess({ model: config.voice?.model });
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public async toggle(enable?: boolean): Promise<boolean> {
    const target = enable !== undefined ? enable : !this.enabled;
    this.enabled = target;

    const config = this.configManager.loadConfig();
    if (!config.voice) config.voice = { enabled: false, model: "base", trigger_key: "Ctrl+B", tts_enabled: false };
    config.voice.enabled = target;
    this.configManager.saveConfig(config);

    if (target) {
      await this.whisper.start();
    } else {
      await this.whisper.stop();
    }

    return this.enabled;
  }

  public getWhisper(): WhisperProcess {
    return this.whisper;
  }
}
