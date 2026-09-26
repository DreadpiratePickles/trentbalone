/**
 * [H5] The CDP connector's contract with Playwright. Without `noDefaults`, attaching makes
 * Playwright set the owner's Chrome to save downloads into its own temporary artifacts folder
 * (deleted on disconnect) and turn on focus and media emulation on the owner's tabs;
 * `noDefaults: true` is Playwright's documented switch for "attaching to a user's daily-driver
 * browser" and leaves those at the browser's own settings.
 */
import { describe, it, expect, vi } from "vitest";

const connectOverCDP = vi.fn(async () => ({ close: async () => undefined }));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP } }));

describe("createCdpConnector", () => {
  it("attaches with noDefaults, so the owner's downloads and emulation settings are left alone", async () => {
    const { createCdpConnector, CDP_CONNECT_TIMEOUT_MS } = await import("./launch.js");
    await createCdpConnector()("http://127.0.0.1:9222");
    expect(connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:9222", { timeout: CDP_CONNECT_TIMEOUT_MS, noDefaults: true });
  });
});
