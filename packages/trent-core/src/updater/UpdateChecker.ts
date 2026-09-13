/**
 * Back-compatible facade. The previous version returned "no update" unconditionally; this one asks
 * the real release source and reports what it finds.
 */

import { resolveLatest, type Channel, type ReleaseOptions, RELEASE_REPO } from "./release.js";
import { compareVersions } from "./version.js";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

export class UpdateChecker {
  constructor(
    private readonly currentVersion = "1.0.0",
    private readonly release: ReleaseOptions = {},
    private readonly channel: Channel = "stable",
  ) {}

  public async checkForUpdates(): Promise<UpdateInfo> {
    const latest = await resolveLatest(this.channel, this.release);
    return {
      currentVersion: this.currentVersion,
      latestVersion: latest.version,
      updateAvailable: compareVersions(latest.version, this.currentVersion) > 0,
      releaseUrl: `https://github.com/${RELEASE_REPO}/releases/tag/${latest.tag}`,
    };
  }
}
