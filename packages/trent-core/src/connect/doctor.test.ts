/**
 * The doctor lines: one per provider, in `CheckResult` shape, naming the state and the command
 * that changes it. Never a value; a token is not even read here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { CONNECT_PROVIDERS } from "./providers.js";
import { connectDoctorLines } from "./doctor.js";
import { ConnectStore } from "./store.js";

let home: string;
let store: ConnectStore;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-connect-doctor-")));
  store = new ConnectStore(new ConfigManager({ baseDir: home }));
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (/^(GOOGLE|STRIPE|BUFFER)_/.test(name)) delete process.env[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("connectDoctorLines", () => {
  it("reports every provider as skip with the connect command when nothing is connected", () => {
    const lines = connectDoctorLines(store);

    expect(lines.map((l) => l.name)).toEqual(CONNECT_PROVIDERS.map((p) => p.doctor.name));
    for (const line of lines) {
      expect(line.category).toBe("connect");
      expect(line.status).toBe("skip");
      expect(line.fixHint).toMatch(/^trent connect /);
    }
  });

  it("reports a connected key as ok and an expired token as warn with the refresh command, never a value", () => {
    store.writeFields("stripe", { STRIPE_SECRET_KEY: "sk_test_doctor_0123456789abcdef" });
    store.writeFields("google", { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "doctor-client-secret" });
    store.writeTokens("google", { accessToken: "access-doctor-0123456789", refreshToken: "refresh-doctor-0123456789", expiresAt: "2026-09-20T00:00:00.000Z", scopes: ["a", "b"] });

    const lines = connectDoctorLines(store, new Date("2026-09-20T01:00:00.000Z"));
    const byId = Object.fromEntries(lines.map((l) => [l.provider, l]));

    expect(byId.stripe).toMatchObject({ status: "ok" });
    expect(byId.google).toMatchObject({ status: "warn", fixHint: "trent connect refresh google" });
    expect(byId.google?.message).toContain("expired");
    expect(byId.google?.message).toContain("2 scopes");
    const text = JSON.stringify(lines);
    for (const secret of ["sk_test_doctor", "access-doctor", "refresh-doctor", "doctor-client-secret"]) expect(text).not.toContain(secret);
  });

  it("[P1-D] names the file each connected provider resolved from, and says when it is the default profile's", () => {
    store.writeFields("stripe", { STRIPE_SECRET_KEY: "sk_test_doctor_inherit_0123456789" });
    const workManager = new ConfigManager({ baseDir: home, profile: "work" });
    const work = new ConnectStore(workManager);
    work.writeFields("buffer", { BUFFER_ACCESS_TOKEN: "buffer-doctor-work-0123456789" });
    const defaultPath = new ConfigManager({ baseDir: home }).getSecretsPath();

    const byId = Object.fromEntries(connectDoctorLines(work).map((l) => [l.provider, l]));

    expect(byId.stripe).toMatchObject({ status: "ok" });
    expect(byId.stripe?.message).toContain(defaultPath);
    expect(byId.stripe?.message).toContain("default profile");
    expect(byId.buffer).toMatchObject({ status: "ok" });
    expect(byId.buffer?.message).toContain(workManager.getSecretsPath());
    expect(byId.buffer?.message).not.toContain("default profile");
    const text = JSON.stringify(Object.values(byId));
    for (const secret of ["sk_test_doctor_inherit", "buffer-doctor-work"]) expect(text).not.toContain(secret);
  });

  it("reports an oauth2 app that is registered but not authorized as skip pointing at trent connect", () => {
    store.writeFields("google", { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "doctor-client-secret" });
    const google = connectDoctorLines(store).find((l) => l.provider === "google");
    expect(google).toMatchObject({ status: "skip", fixHint: "trent connect google" });
    expect(google?.message).toContain("not authorized");
  });
});
