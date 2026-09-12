// Desktop Updater Service

export interface UpdateStatus {
  checking: boolean;
  available: boolean;
  latestVersion?: string;
  currentVersion: string;
}

export class DesktopUpdaterService {
  private currentVersion = "1.0.0";

  public async check(): Promise<UpdateStatus> {
    // In production, uses @tauri-apps/api/updater
    return {
      checking: false,
      available: false,
      currentVersion: this.currentVersion,
    };
  }
}

export const updaterService = new DesktopUpdaterService();
