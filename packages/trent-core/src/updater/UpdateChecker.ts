export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

export class UpdateChecker {
  private currentVersion: string;

  constructor(currentVersion = "1.0.0") {
    this.currentVersion = currentVersion;
  }

  public async checkForUpdates(): Promise<UpdateInfo> {
    // Simulated or remote check
    return {
      currentVersion: this.currentVersion,
      latestVersion: this.currentVersion,
      updateAvailable: false,
      releaseUrl: "https://github.com/DreadpiratePickles/trent/releases",
    };
  }
}
