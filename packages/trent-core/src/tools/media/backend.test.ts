/**
 * `mediaImagePresent` over the exec seam: no daemon is involved, each fake answers exactly as a
 * daemon answered on a real machine.
 *
 * P2-3 (docs/sessions/2026-09-25-p2-3-voice-notes.md) saw Docker 29.5.3 answer "No such image" to
 * the image-inspect endpoint for `trent-sandbox-media:1` while `docker image ls` listed it and
 * `docker run` ran it, so `media.backend: auto` quietly chose the host. An earlier session saw the
 * same split with the forms swapped (`doctor/checks/workbench.ts`). Both inspect forms call the
 * same endpoint; `docker image ls --filter reference=` calls another. So the probe asks inspect
 * first, and when inspect says absent it asks the list before choosing the host.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MEDIA_IMAGE, mediaImagePresent, selectMediaBackend, type MediaExec, type MediaExecResult } from "./backend.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-media-backend-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
// `mediaImagePresent` resolves docker on PATH before asking; the fake exec is what answers.
fs.writeFileSync(path.join(root, "docker"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
const env = { PATH: root, HOME: root };

const ok = (stdout: string): MediaExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): MediaExecResult => ({ code: 1, stdout: "", stderr });
const noSuchImage = (ref: string) => fail(`Error response from daemon: No such image: ${ref}`);

type Answer = (args: readonly string[]) => MediaExecResult;

/** A fake docker CLI: records every argv and answers by the command form. */
function daemon(answers: { inspect: Answer; list: Answer }) {
  const calls: string[][] = [];
  const exec: MediaExec = async (command, args) => {
    calls.push([path.basename(command), ...args]);
    const isInspect = (args[0] === "inspect" && args[1] === "--type" && args[2] === "image") || (args[0] === "image" && args[1] === "inspect");
    if (isInspect) return answers.inspect(args);
    if (args[0] === "image" && (args[1] === "ls" || args[1] === "list")) return answers.list(args);
    return fail(`unexpected docker ${args.join(" ")}`);
  };
  return { exec, calls };
}

const reference = (args: readonly string[]): string | undefined => args.find((arg) => arg.startsWith("reference="))?.slice("reference=".length);

describe("mediaImagePresent", () => {
  it("finds the image on a daemon whose inspect says 'No such image' for an image it lists (Docker 29.5.3, as P2-3 saw it)", async () => {
    const fake = daemon({
      inspect: (args) => noSuchImage(args[args.length - 1] ?? ""),
      list: (args) => (reference(args) === MEDIA_IMAGE ? ok("99d8c656aec6\n") : ok("")),
    });
    expect(await mediaImagePresent(env, fake.exec)).toBe(true);
    expect(fake.calls.some((call) => call[1] === "image" && call[2] === "ls" && call.includes(`reference=${MEDIA_IMAGE}`))).toBe(true);
    // And `auto` therefore picks the container, not the host.
    expect((await selectMediaBackend({ workspace: root, env, exec: fake.exec, backend: "auto" })).kind).toBe("docker");
  });

  it("finds the image on a daemon where inspect answers (this machine today, and daemons older than the reference filter)", async () => {
    const fake = daemon({
      inspect: () => ok("sha256:99d8c656aec6e5f6cf9b1dca5f9281dd7605f7e08bf115ebe870e88db4caed8f\n"),
      list: () => fail("Error response from daemon: Invalid filter 'reference'"),
    });
    expect(await mediaImagePresent(env, fake.exec)).toBe(true);
    // Inspect answered, so the list is never asked.
    expect(fake.calls).toHaveLength(1);
  });

  it("reports absent only when both inspect and the list say so", async () => {
    const fake = daemon({ inspect: (args) => noSuchImage(args[args.length - 1] ?? ""), list: () => ok("") });
    expect(await mediaImagePresent(env, fake.exec)).toBe(false);
    expect(fake.calls).toHaveLength(2);
    expect((await selectMediaBackend({ workspace: root, env, exec: fake.exec, backend: "auto" })).kind).toBe("host");
  });

  it("reports absent when the daemon is down, when the exec cannot spawn, and when docker is not on PATH", async () => {
    const down = fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
    expect(await mediaImagePresent(env, daemon({ inspect: () => down, list: () => down }).exec)).toBe(false);
    const throws: MediaExec = async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    };
    expect(await mediaImagePresent(env, throws)).toBe(false);
    const never = daemon({ inspect: () => ok("sha256:1\n"), list: () => ok("1\n") });
    expect(await mediaImagePresent({ PATH: path.join(root, "nothing"), HOME: root }, never.exec)).toBe(false);
    expect(never.calls).toEqual([]);
  });

  it("asks the list for exactly the reference, with `:latest` when the reference names no tag", async () => {
    const fake = daemon({ inspect: (args) => noSuchImage(args[args.length - 1] ?? ""), list: () => ok("") });
    await mediaImagePresent(env, fake.exec, "trent-sandbox-media");
    await mediaImagePresent(env, fake.exec, "localhost:5000/trent-sandbox-media");
    expect(fake.calls.map((call) => reference(call)).filter((ref) => ref !== undefined)).toEqual([
      "trent-sandbox-media:latest",
      "localhost:5000/trent-sandbox-media:latest",
    ]);
  });
});
