/**
 * The market packs do their jobs through their skills (scorecard 2026-09-25, retraction 4).
 *
 * A pack declares the toolsets its crew works through; its skills are the procedures a seat reads
 * through `skill_view`. This file reads every pack skill as a seat would and checks it against the
 * registries themselves (`tools/<toolset>/schemas.ts`, `tools/tool-names.ts`) and the seat manifests
 * (`seat-capabilities.ts`), so a skill can only stay green by naming a tool that exists, with the
 * arguments its schema declares, run by a seat that carries the toolset:
 *
 *   - every tool a skill names is one of its pack's toolsets exposes (no invented names);
 *   - the pack's skills, together, call at least one tool of every toolset the pack declares;
 *   - every `<tool> {json}` call parses, uses only argument names in the tool's schema, carries the
 *     required ones and the right types (a placeholder in angle brackets stands for a value);
 *   - the seats a skill says run it are pack members, and one of them carries each toolset it uses;
 *   - a skill that writes says the call waits for approval; one that texts says SMS is outbound
 *     only; a social example uses a platform live without an application; media calls follow the
 *     docs/media.md order.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_CATALOG } from "../agents/index.js";
import type { Toolset } from "../config/schema.js";
import { parseFrontmatter } from "../skills/skill-store.js";
import { BUSINESS_TOOL_SCHEMAS, WRITE_TOOLS as BUSINESS_WRITES } from "../tools/business/schemas.js";
import { MEDIA_TOOL_SCHEMAS } from "../tools/media/schemas.js";
import { SOCIAL_TOOL_SCHEMAS } from "../tools/social/schemas.js";
import { BUILTIN_TOOLS_BY_TOOLSET } from "../tools/tool-names.js";
import type { ToolSchema } from "../tools/web/schemas.js";
import { FLEET_PACKS } from "./FleetPacks.js";
import { SEAT_CAPABILITIES, isSeatRole } from "./seat-capabilities.js";
import { listSourceSkills } from "./SkillProvisioner.js";

/** The toolsets whose tools a market skill calls, with their schemas. */
const SCHEMAS: Readonly<Record<string, readonly ToolSchema[]>> = { business: BUSINESS_TOOL_SCHEMAS, social: SOCIAL_TOOL_SCHEMAS, media: MEDIA_TOOL_SCHEMAS };
const TOOLSET_NAMES = new Set<string>([...Object.keys(BUILTIN_TOOLS_BY_TOOLSET), ...Object.keys(SCHEMAS)]);

function toolsOf(toolset: string): readonly string[] {
  const schemas = SCHEMAS[toolset];
  if (schemas !== undefined) return schemas.map((schema) => schema.name);
  return (BUILTIN_TOOLS_BY_TOOLSET[toolset] ?? []).filter((name) => !TOOLSET_NAMES.has(name));
}

/** Tool name -> its toolset, over every toolset Trent answers to. */
const TOOLSET_OF = new Map<string, string>();
for (const toolset of TOOLSET_NAMES) for (const tool of toolsOf(toolset)) TOOLSET_OF.set(tool, toolset);
const SCHEMA_OF = new Map<string, ToolSchema>(Object.values(SCHEMAS).flat().map((schema) => [schema.name, schema]));

/** Every argument name in the three schemas (`customer_note`, `media_url`), which look like tools and are not. */
const ARGUMENT_NAMES = new Set<string>();
function collectArgs(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.properties !== undefined && typeof record.properties === "object") {
    for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) {
      ARGUMENT_NAMES.add(key);
      collectArgs(child);
    }
  }
  if (record.items !== undefined) collectArgs(record.items);
}
for (const schema of SCHEMA_OF.values()) collectArgs(schema.parameters);

/** A name shaped like a market tool: an invented `stripe_refund_create` or `social_dm_send` is caught by this. */
const TOOL_SHAPED = /\b(?:stripe|square|calendar|sms|social|media|customer)_[a-z][a-z0-9_]*\b/g;
const SOCIAL_WRITES = new Set(["social_post", "social_reply", "social_schedule"]);
const WRITE_TOOLS = new Set<string>([...BUSINESS_WRITES, ...SOCIAL_WRITES, "media_image"]);
/** docs/media.md, "The media toolset": the order a clip pipeline runs in. */
const MEDIA_ORDER = ["media_probe", "media_transcribe", "media_scenes", "media_clip", "media_thumbnail", "media_image"];
/** docs/social.md, the matrix: live today with no application, no review and no app store. */
const LIVE_REPLY_PLATFORMS = new Set(["bluesky"]);
const LIVE_POST_PLATFORMS = new Set(["bluesky", "x", "linkedin", "threads", "facebook"]);

const EXPECTED_TOOLSETS: Readonly<Record<string, readonly Toolset[]>> = {
  "small-business": ["business", "social"],
  social: ["social"],
  creator: ["media"],
};
const MARKET_PACKS = Object.keys(EXPECTED_TOOLSETS).map((id) => FLEET_PACKS[id]!);

interface Invocation {
  readonly tool: string;
  readonly json: string;
}

interface ReadSkill {
  readonly slug: string;
  readonly text: string;
  readonly body: string;
  readonly mentions: readonly string[];
  readonly invocations: readonly Invocation[];
}

const SOURCE = new Map(listSourceSkills().map((entry) => [entry.name, entry.file]));

function isToolLike(name: string): boolean {
  if (TOOLSET_OF.has(name)) return true;
  TOOL_SHAPED.lastIndex = 0;
  return TOOL_SHAPED.test(name) && !ARGUMENT_NAMES.has(name);
}

/** The `<tool> {json}` calls: a fenced line, an inline span, or a tool span followed by a `{...}` span in the same paragraph. */
function invocationsOf(body: string): Invocation[] {
  const found: Invocation[] = [];
  const fences = /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm; // a fence may be indented under a list item
  for (const block of body.matchAll(fences)) {
    for (const line of block[1]!.split("\n")) {
      const call = /^\s*([a-z][a-z0-9_]*)\s+(\{.*\})\s*$/.exec(line);
      if (call && isToolLike(call[1]!)) found.push({ tool: call[1]!, json: call[2]! });
    }
  }
  for (const paragraph of body.replace(fences, "\n\n").split(/\n\s*\n/)) {
    let lastTool: string | undefined;
    for (const span of paragraph.matchAll(/`([^`]+)`/g)) {
      const content = span[1]!.trim();
      const inline = /^([a-z][a-z0-9_]*)\s+(\{[\s\S]*\})$/.exec(content);
      if (inline && isToolLike(inline[1]!)) {
        found.push({ tool: inline[1]!, json: inline[2]! });
        lastTool = inline[1]!;
      } else if (/^[a-z][a-z0-9_]*$/.test(content) && isToolLike(content)) {
        lastTool = content;
      } else if (content.startsWith("{") && lastTool !== undefined) {
        found.push({ tool: lastTool, json: content });
      }
    }
  }
  return found;
}

function mentionsOf(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(TOOL_SHAPED)) if (!ARGUMENT_NAMES.has(match[0])) names.add(match[0]);
  for (const span of text.matchAll(/`([a-z][a-z0-9_]*)(?:\s+\{[^`]*\})?`/g)) if (TOOLSET_OF.has(span[1]!)) names.add(span[1]!);
  return [...names];
}

function readSkill(slug: string): ReadSkill {
  const file = SOURCE.get(slug);
  if (file === undefined) throw new Error(`no source carries the skill ${slug}`);
  const text = fs.readFileSync(file, "utf8");
  const { body } = parseFrontmatter(text);
  return { slug, text, body, mentions: mentionsOf(text), invocations: invocationsOf(body) };
}

/** A value in angle brackets is a placeholder the seat fills in; outside quotes it reads as a number. */
function parseArgs(json: string): unknown {
  return JSON.parse(json.replace(/(:\s*)<[^<>"\n]*>/g, "$10"));
}

const PLACEHOLDER = /<[^<>]+>/;
const E164_OR_SERVICE = /^(\+[1-9]\d{6,14}|MG[0-9a-zA-Z]{32})$/; // `tools/business/money.ts` E164, or a Messaging Service SID

/** Problems with one value against one JSON-schema node. */
function argProblems(value: unknown, node: Record<string, unknown>, at: string): string[] {
  const problems: string[] = [];
  const type = node.type;
  if (Array.isArray(node.enum) && typeof value === "string" && !PLACEHOLDER.test(value) && !node.enum.includes(value)) {
    problems.push(`${at} is "${value}", not one of ${node.enum.join(", ")}`);
  }
  if (type === "object" || node.properties !== undefined) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${at} is not an object`];
    const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const schema = properties[key];
      if (schema === undefined) problems.push(`${at}.${key} is not an argument the schema declares`);
      else problems.push(...argProblems(child, schema, `${at}.${key}`));
    }
    for (const key of (node.required ?? []) as string[]) if (!(key in (value as object))) problems.push(`${at}.${key} is required and missing`);
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${at} is not an array`];
    value.forEach((item, index) => problems.push(...argProblems(item, node.items as Record<string, unknown>, `${at}[${String(index)}]`)));
  } else if (type === "integer" || type === "number") {
    if (typeof value === "string" ? !PLACEHOLDER.test(value) : typeof value !== "number") problems.push(`${at} is not a number`);
    if (type === "integer" && typeof value === "number" && !Number.isInteger(value)) problems.push(`${at} is ${String(value)}, not integer cents or an integer`);
  } else if (type === "boolean" && typeof value !== "boolean") {
    problems.push(`${at} is not a boolean`);
  } else if (type === "string") {
    if (typeof value !== "string") problems.push(`${at} is not a string`);
    else if (/RFC 3339/.test(String(node.description)) && !PLACEHOLDER.test(value) && !/(Z|[+-]\d\d:\d\d)$/.test(value)) problems.push(`${at} "${value}" has no offset`);
  }
  if (at.endsWith(".currency") && typeof value === "string" && !/^[a-z]{3}$/.test(value)) problems.push(`${at} "${value}" is not a lowercase ISO 4217 code`);
  return problems;
}

function callProblems(skill: ReadSkill): string[] {
  const problems: string[] = [];
  for (const call of skill.invocations) {
    const schema = SCHEMA_OF.get(call.tool);
    if (schema === undefined) continue;
    let args: unknown;
    try {
      args = parseArgs(call.json);
    } catch {
      problems.push(`${skill.slug}: ${call.tool} ${call.json} is not JSON`);
      continue;
    }
    for (const problem of argProblems(args, schema.parameters as Record<string, unknown>, call.tool)) problems.push(`${skill.slug}: ${problem}`);
    const record = args as Record<string, unknown>;
    if (call.tool === "sms_send") {
      for (const key of ["to", "from"]) if (typeof record[key] === "string" && !E164_OR_SERVICE.test(record[key] as string)) problems.push(`${skill.slug}: sms_send ${key} is not E.164`);
    }
    if (call.tool.startsWith("social_") && typeof record.platform === "string") {
      const live = SOCIAL_WRITES.has(call.tool) && call.tool !== "social_reply" ? LIVE_POST_PLATFORMS : LIVE_REPLY_PLATFORMS;
      if (!live.has(record.platform)) problems.push(`${skill.slug}: ${call.tool} example on ${record.platform}, which waits for an application; use a live platform and say "when connected" for the rest`);
      if ("media_url" in record) problems.push(`${skill.slug}: ${call.tool} passes media_url, which Bluesky drops and Buffer refuses`);
    }
  }
  return problems;
}

function toolsetsUsed(skill: ReadSkill): Set<string> {
  return new Set([...skill.mentions, ...skill.invocations.map((call) => call.tool)].map((tool) => TOOLSET_OF.get(tool)).filter((t): t is string => t !== undefined));
}

const CATALOG_IDS = new Set(AGENT_CATALOG.map((agent) => agent.id));

/** The seats and specialists named on the skill's "Who runs it:" paragraph (a backticked toolset name is not one). */
function runnersOf(skill: ReadSkill): string[] {
  const start = skill.body.search(/^Who runs it:/m);
  const paragraph = start === -1 ? "" : skill.body.slice(start).split(/\n\s*\n/)[0]!;
  return [...paragraph.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((match) => match[1]!).filter((id) => isSeatRole(id) || CATALOG_IDS.has(id));
}

describe("the market packs' skills call the toolsets the pack declares", () => {
  it("each market pack declares the toolsets its crew works through, and a member seat carries each one", () => {
    for (const pack of MARKET_PACKS) {
      expect(pack.toolsets, `${pack.id} declares no toolsets`).toEqual(EXPECTED_TOOLSETS[pack.id]);
      for (const toolset of pack.toolsets) {
        const carriers = pack.agents.filter((id) => isSeatRole(id) && SEAT_CAPABILITIES[id].toolsets.includes(toolset));
        expect(carriers, `no ${pack.id} seat carries ${toolset}`).not.toEqual([]);
      }
    }
    for (const pack of Object.values(FLEET_PACKS)) if (!(pack.id in EXPECTED_TOOLSETS)) expect(pack.toolsets, pack.id).toEqual([]);
  });

  it("the pack's skills, together, call at least one tool of every toolset the pack declares", () => {
    for (const pack of MARKET_PACKS) {
      const used = new Set(pack.skills.flatMap((slug) => [...toolsetsUsed(readSkill(slug))]));
      for (const toolset of EXPECTED_TOOLSETS[pack.id]!) {
        expect(used.has(toolset), `${pack.id} skills call no ${toolset} tool (${toolsOf(toolset).join(", ")})`).toBe(true);
      }
    }
  });

  it("each business and social skill makes the calls its job needs, as <tool> {json} a seat can copy", () => {
    const expected: Record<string, readonly string[]> = {
      "quote-estimate": ["customer_search", "stripe_quote_create"],
      "invoice-draft": ["customer_search", "stripe_payment_link_create", "stripe_invoice_create", "square_invoice_create", "stripe_invoice_send", "square_invoice_send"],
      "booking-followup": ["calendar_list", "square_bookings_list", "sms_send", "square_booking_cancel", "square_booking_create", "calendar_appointment_cancel", "calendar_appointment_create"],
      "review-response": ["social_platforms_list", "social_inbox_list", "social_reply"],
      "local-business-post": ["social_platforms_list", "social_post", "social_schedule", "social_insights_read"],
      "content-calendar": ["social_platforms_list", "social_insights_read", "social_schedule"],
      "brand-voice-capture": ["social_insights_read"],
      "crosspost-adapt": ["social_platforms_list", "social_post", "social_schedule"],
      "comment-triage": ["social_inbox_list", "social_reply"],
      "clip-plan": MEDIA_ORDER,
    };
    for (const [slug, tools] of Object.entries(expected)) {
      const called = new Set(readSkill(slug).invocations.map((call) => call.tool));
      for (const tool of tools) expect(called.has(tool), `${slug} never calls ${tool} with its arguments`).toBe(true);
    }
  });

  it("every tool a pack skill names is one its pack's toolsets expose: no invented tool, no tool from outside the pack", () => {
    const offenders: string[] = [];
    for (const pack of MARKET_PACKS) {
      const allowed = new Set(EXPECTED_TOOLSETS[pack.id]!.flatMap((toolset) => toolsOf(toolset)));
      for (const slug of pack.skills) {
        for (const tool of readSkill(slug).mentions) if (!allowed.has(tool)) offenders.push(`${pack.id}/${slug} names ${tool}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every business and social skill makes a real call, and every call matches its tool's schema", () => {
    const problems: string[] = [];
    for (const pack of MARKET_PACKS) {
      for (const slug of pack.skills) {
        const skill = readSkill(slug);
        const market = skill.invocations.filter((call) => SCHEMA_OF.has(call.tool));
        if (market.length === 0) problems.push(`${pack.id}/${slug} makes no <tool> {json} call`);
        problems.push(...callProblems(skill));
      }
    }
    expect(problems).toEqual([]);
  });

  it("names the seats that run each skill, pack members only, and one of them carries every toolset the skill uses", () => {
    const problems: string[] = [];
    for (const pack of MARKET_PACKS) {
      for (const slug of pack.skills) {
        const skill = readSkill(slug);
        const runners = runnersOf(skill);
        if (runners.length === 0) problems.push(`${slug} has no "Who runs it:" line naming a seat`);
        for (const seat of runners) if (!pack.agents.includes(seat)) problems.push(`${slug} names ${seat}, which is not in the ${pack.id} pack`);
        for (const toolset of toolsetsUsed(skill)) {
          const carried = runners.some((seat) => isSeatRole(seat) && SEAT_CAPABILITIES[seat].toolsets.includes(toolset as Toolset));
          if (!carried) problems.push(`${slug} uses ${toolset}, which none of its named seats (${runners.join(", ")}) carries`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("says a write waits for the owner's approval, SMS is outbound only, and names no toolset as still to land", () => {
    const problems: string[] = [];
    for (const pack of MARKET_PACKS) {
      for (const slug of pack.skills) {
        const skill = readSkill(slug);
        const tools = new Set([...skill.mentions, ...skill.invocations.map((call) => call.tool)]);
        if ([...tools].some((tool) => WRITE_TOOLS.has(tool)) && !/approv/i.test(skill.body)) problems.push(`${slug} writes and never says approval`);
        if (tools.has("sms_send")) {
          if (!/outbound/i.test(skill.body)) problems.push(`${slug} texts and never says SMS is outbound only`);
          if (/\bReply (Y|YES|R)\b/.test(skill.body)) problems.push(`${slug} asks a customer to text back, which nothing here reads`);
        }
        if ([...tools].some((tool) => tool.startsWith("social_")) && /instagram|facebook|youtube|tiktok|google business profile/i.test(skill.body) && !/when connected/i.test(skill.body)) {
          problems.push(`${slug} names a platform that needs an application without saying "when connected"`);
        }
        if (/\b(until|when|once|after) the (business|social|media) toolset (lands|is connected)|(not|n't) (yet )?landed/i.test(skill.text)) problems.push(`${slug} still says a toolset has not landed`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("calls the media tools in the order docs/media.md runs them: probe, transcribe, scenes, clip, thumbnail, image", () => {
    for (const slug of FLEET_PACKS.creator!.skills) {
      const order = readSkill(slug).invocations.map((call) => MEDIA_ORDER.indexOf(call.tool)).filter((index) => index >= 0);
      const firsts = [...new Set(order)];
      expect(firsts, `${slug} calls the media tools out of order`).toEqual([...firsts].sort((a, b) => a - b));
    }
  });
});

describe("the pack skill parser", () => {
  it("finds inline, attached and fenced calls, and refuses an invented tool and an undeclared argument", () => {
    const body = [
      "Run `stripe_quote_create` with `{\"customer\": \"cus_1\", \"currency\": \"usd\", \"items\": [{\"description\": \"a\", \"amount_cents\": 100}]}`.",
      "",
      "Then `sms_send {\"to\": \"+15551230100\", \"from\": \"+15551230199\", \"body\": \"hi\", \"media\": \"x\"}` and `stripe_refund_create`.",
      "",
      "```",
      "social_post {\"platform\": \"bluesky\", \"text\": \"<post>\"}",
      "```",
    ].join("\n");
    const skill: ReadSkill = { slug: "fixture", text: body, body, mentions: mentionsOf(body), invocations: invocationsOf(body) };
    expect(skill.invocations.map((call) => call.tool).sort()).toEqual(["sms_send", "social_post", "stripe_quote_create"]);
    expect(skill.mentions).toContain("stripe_refund_create");
    expect(callProblems(skill)).toEqual(["fixture: sms_send.media is not an argument the schema declares"]);
    const float = { ...skill, invocations: [{ tool: "stripe_payment_link_create", json: '{"currency": "USD", "items": [{"description": "a", "amount_cents": 12.5}]}' }] };
    expect(callProblems(float)).toEqual([
      "fixture: stripe_payment_link_create.currency \"USD\" is not a lowercase ISO 4217 code",
      "fixture: stripe_payment_link_create.items[0].amount_cents is 12.5, not integer cents or an integer",
    ]);
  });
});

