/**
 * [C16] The bench's world: the business fakes (`world-business.ts`), the social fake every social host is
 * rewritten to (`tools/social/testing/fake-platforms.ts`, whose one Bluesky mention a task replies to), a
 * workspace directory, and the owner's decisions. One world serves a whole bench run: its endpoints stay
 * put, and `reset(seed)` puts every account and the workspace back to a task's starting state before each
 * attempt, so a runtime built once against these endpoints serves every task.
 *
 * Nothing here reaches a real provider: every base URL is `http://127.0.0.1:<port>`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakePlatforms, type FakePlatforms } from "../tools/social/testing/fake-platforms.js";
import type { BusinessProviderId } from "../tools/business/http.js";
import { startBusinessFakes, type BusinessFakes } from "./world-business.js";
import type { BusinessState, OperatorDecision, WorldSeed, WorldView } from "./types.js";

/** The one mention the social fake answers `listNotifications` with (`fake-platforms.ts`). */
export const BLUESKY_MENTION_URI = "at://did:plc:other/app.bsky.feed.post/3kmention";

export interface BenchWorld extends WorldView {
  readonly workspace: string;
  readonly endpoints: Record<BusinessProviderId, string>;
  /** The social toolset's fetch seam: the real host's path and query, sent to the local fake. */
  readonly socialFetch: FakePlatforms["fetch"];
  /** Where the operator writes what it decided. */
  readonly decisionLog: OperatorDecision[];
  reset(seed: WorldSeed): void;
  stop(): Promise<void>;
}

const CREATE_RECORD = "/xrpc/com.atproto.repo.createRecord";
const LIST_NOTIFICATIONS = "/xrpc/app.bsky.notification.listNotifications";
const GET_RECORD = "/xrpc/com.atproto.repo.getRecord";

function emptyDirectory(dir: string): void {
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
}

/**
 * The Bluesky records the fake received, in order: a post, or a reply naming the post it answers. The fake's
 * `getRecord` answers one fixed parent whatever it is asked for, so the post a reply answers is the one the
 * tool ASKED for just before it (`tools/social/bluesky.ts` reply: getRecord(parent), then createRecord).
 */
function blueskyRecords(platforms: FakePlatforms): { text: string; replyTo?: string }[] {
  const records: { text: string; replyTo?: string }[] = [];
  let asked: string | undefined;
  for (const request of platforms.requests) {
    if (request.path.startsWith(GET_RECORD)) {
      const query = new URL(request.path, "http://fake").searchParams;
      asked = `at://${query.get("repo") ?? ""}/${query.get("collection") ?? ""}/${query.get("rkey") ?? ""}`;
      continue;
    }
    if (request.method !== "POST" || !request.path.startsWith(CREATE_RECORD)) continue;
    try {
      const record = (JSON.parse(request.body) as { record?: { text?: unknown; reply?: unknown } }).record ?? {};
      const text = typeof record.text === "string" ? record.text : "";
      records.push(record.reply === undefined ? { text } : { text, replyTo: asked ?? "unknown" });
    } catch {
      records.push({ text: "" });
    }
  }
  return records;
}

function socialOperations(platforms: FakePlatforms): string[] {
  return platforms.requests.flatMap((request) => {
    if (request.path.startsWith(CREATE_RECORD)) return ["bluesky.record.create"];
    if (request.path.startsWith(LIST_NOTIFICATIONS)) return ["bluesky.notifications.list"];
    return [];
  });
}

export async function startBenchWorld(options: { readonly workspace?: string } = {}): Promise<BenchWorld> {
  const workspace = options.workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "trent-bench-ws-"));
  const owned = options.workspace === undefined;
  let business: BusinessFakes | undefined;
  let platforms: FakePlatforms | undefined;
  try {
    business = await startBusinessFakes();
    platforms = await startFakePlatforms();
  } catch (error) {
    await business?.stop();
    if (owned) fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
  const biz = business;
  const social = platforms;
  const decisionLog: OperatorDecision[] = [];

  const file = (relative: string): string | undefined => {
    const target = path.resolve(workspace, relative);
    if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`)) return undefined;
    try {
      return fs.readFileSync(target, "utf8");
    } catch {
      return undefined;
    }
  };

  return {
    workspace,
    endpoints: biz.endpoints,
    socialFetch: social.fetch,
    decisionLog,
    get state(): BusinessState {
      return biz.state;
    },
    get operations(): readonly string[] {
      return [...biz.operations, ...socialOperations(social)];
    },
    get blueskyRecords() {
      return blueskyRecords(social);
    },
    get decisions(): readonly OperatorDecision[] {
      return [...decisionLog];
    },
    file,
    reset(seed) {
      biz.reset(seed);
      social.requests.length = 0;
      decisionLog.length = 0;
      emptyDirectory(workspace);
      for (const [relative, text] of Object.entries(seed.files ?? {})) {
        const target = path.resolve(workspace, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
      }
    },
    async stop() {
      await biz.stop();
      await social.close();
      if (owned) fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}
