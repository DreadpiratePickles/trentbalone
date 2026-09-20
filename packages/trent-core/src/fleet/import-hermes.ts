/**
 * X6 — `fleet import --from hermes`: a Hermes profile distribution (research 1c,
 * https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions), as the
 * directory `hermes profile install` reads or the `<name>.tar.gz` that `hermes profile export`
 * and `fleet export --target hermes` write, read into the foreign-agent shape:
 *
 *   distribution.yaml   `name` (required by Hermes, so required here), `description`; the seat
 *                       id when the description is the exporter's ("Trent seat <id>, version N")
 *   SOUL.md             the prompt (its `## Seat prompt` section when the file is one we wrote)
 *   config.yaml         toolsets from `platform_toolsets.*`, `toolsets` and `agent.toolsets`,
 *                       mapped back by the shared names (`HERMES_TOOLSET_NAMES` reversed);
 *                       `agent.disabled_toolsets` as denied; `mcp_servers.*`
 *   mcp.json            `mcpServers`, the Agent Plugins shape, merged with config's
 *   skills/**\/SKILL.md  nested any depth (Hermes files skills under a category directory)
 *
 * The archive is read with a small ustar reader over `node:zlib`, the mirror of `targz.ts`:
 * regular files and directories only, under exactly one top-level directory, every path checked
 * against escaping the extraction directory; anything else is refused, typed. The extraction
 * lives in a temporary directory that `cleanup()` removes. Memory never comes in: Hermes never
 * exports `memories/`, and a `memories/` directory in a hand-built archive is ignored.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";

import { ALWAYS_ON_ADAPTERS } from "../tools/index.js";
import { HERMES_MCP_SERVER_NAME, HERMES_TOOLSET_NAMES } from "./export-hermes.js";
import { agentIdFrom, normaliseMcpEntry, readSkillTree, refuseImport, resolveGrants, seatPromptOf, type ForeignAgent, type ForeignMcpServer } from "./import-foreign.js";

const MANIFEST = "distribution.yaml";
const SOUL = "SOUL.md";
const CONFIG = "config.yaml";
const MCP_JSON = "mcp.json";
const SKILLS_DIR = "skills";
const BLOCK = 512;
/** Hermes toolset -> Trent toolset: `HERMES_TOOLSET_NAMES` read the other way. */
export const TRENT_TOOLSET_BY_HERMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(HERMES_TOOLSET_NAMES).flatMap(([trent, hermes]) => (hermes === null ? [] : [[hermes, trent]])),
);
/** The description the exporter writes carries the seat id; a foreign profile's does not. */
const EXPORTED_SEAT = /\(Trent seat ([A-Za-z0-9._-]+), version \d+/;
/**
 * Hermes toolset names that are not capabilities: the server alias and the always-on adapters
 * every seat has anyway. `clarify` is always on too, but it IS Hermes's name for asking the
 * person, so it maps to `human` rather than being dropped.
 */
const NOT_TOOLSETS: ReadonlySet<string> = new Set([HERMES_MCP_SERVER_NAME, ...ALWAYS_ON_ADAPTERS.filter((name) => TRENT_TOOLSET_BY_HERMES[name] === undefined)]);

/** Hermes names as Trent toolsets, once each, plus the names Hermes has and Trent does not. */
export function hermesToolsets(names: readonly string[]): { toolsets: string[]; unmapped: string[] } {
  const toolsets: string[] = [];
  const unmapped: string[] = [];
  for (const name of names) {
    if (NOT_TOOLSETS.has(name)) continue;
    const trent = TRENT_TOOLSET_BY_HERMES[name];
    if (trent === undefined) unmapped.push(name);
    else if (!toolsets.includes(trent)) toolsets.push(trent);
  }
  return { toolsets, unmapped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ── the archive ────────────────────────────────────────────────────────────────

function field(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
}

/**
 * Extracts the archive into a fresh temporary directory and returns the one top-level
 * directory it holds. Regular files and directories only; a path with `..` or an absolute
 * path, a second top-level entry, or a truncated archive is refused, typed.
 */
function extract(archive: string, target: string): { root: string; tmp: string } {
  let data: Buffer;
  try {
    data = gunzipSync(fs.readFileSync(archive));
  } catch (error) {
    throw refuseImport("hermes", `${archive} is not a gzip archive: ${error instanceof Error ? error.message : String(error)}`, target);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trent-import-hermes-"));
  const refuse = (why: string): never => {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw refuseImport("hermes", `${archive}: ${why}`, target);
  };
  let top: string | undefined;
  let offset = 0;
  while (offset + BLOCK <= data.length) {
    const block = data.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (block.every((byte) => byte === 0)) break;
    const prefix = field(block, 257, 6).startsWith("ustar") ? field(block, 345, 155) : "";
    const name = `${prefix === "" ? "" : `${prefix}/`}${field(block, 0, 100)}`;
    const size = Number.parseInt(field(block, 124, 12).trim() || "0", 8);
    const type = field(block, 156, 1);
    const payload = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + payload > data.length) refuse("truncated archive");
    const relative = name.replace(/\/+$/, "");
    const segments = relative.split("/");
    if (relative === "" || path.isAbsolute(relative) || segments.some((s) => s === ".." || s === "")) refuse(`entry "${name}" would escape the extraction directory`);
    if (top === undefined) top = segments[0];
    else if (segments[0] !== top) refuse(`more than one top-level directory ("${top}" and "${segments[0]}"); a profile archive holds exactly one`);
    const out = path.join(tmp, ...segments);
    if (type === "5") fs.mkdirSync(out, { recursive: true });
    else if (type === "0" || type === "") {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data.subarray(offset, offset + size));
    } else refuse(`entry "${name}" is neither a regular file nor a directory (type "${type}"); links and special files are not read`);
    offset += payload;
  }
  if (top === undefined) refuse("empty archive");
  return { root: path.join(tmp, top!), tmp };
}

// ── the profile ────────────────────────────────────────────────────────────────

function readYaml(file: string, relative: string, target: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw refuseImport("hermes", `${relative} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`, target);
  }
  return isRecord(parsed) ? parsed : {};
}

function readServers(config: Record<string, unknown>, root: string, sources: string[], notCarried: string[]): ForeignMcpServer[] {
  const raw: Record<string, unknown> = {};
  if (isRecord(config.mcp_servers)) Object.assign(raw, config.mcp_servers);
  const file = path.join(root, MCP_JSON);
  if (fs.existsSync(file)) {
    sources.push(MCP_JSON);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (isRecord(parsed) && isRecord(parsed.mcpServers)) Object.assign(raw, parsed.mcpServers);
    } catch (error) {
      notCarried.push(`${MCP_JSON}: not valid JSON (${error instanceof Error ? error.message : String(error)}); its servers are not imported`);
    }
  }
  const out: ForeignMcpServer[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    const normalised = normaliseMcpEntry(name, entry);
    notCarried.push(...normalised.notes);
    if (normalised.entry !== undefined) out.push({ name, entry: normalised.entry });
  }
  return out;
}

/** Every toolset list a Hermes `config.yaml` may carry, flattened. */
function configuredToolsets(config: Record<string, unknown>): string[] {
  const names: string[] = [...strings(config.toolsets)];
  if (isRecord(config.platform_toolsets)) for (const list of Object.values(config.platform_toolsets)) names.push(...strings(list));
  if (isRecord(config.agent)) names.push(...strings(config.agent.toolsets));
  return names;
}

export function readHermesProfile(target: string): ForeignAgent {
  if (!fs.existsSync(target)) throw refuseImport("hermes", `${target} does not exist`, target);
  const archive = fs.statSync(target).isFile();
  const extracted = archive ? extract(target, target) : undefined;
  const root = extracted?.root ?? target;
  const cleanup = (): void => {
    if (extracted !== undefined) fs.rmSync(extracted.tmp, { recursive: true, force: true });
  };
  try {
    const manifestFile = path.join(root, MANIFEST);
    if (!fs.existsSync(manifestFile)) throw refuseImport("hermes", `no ${MANIFEST} at the root of ${archive ? `the archive's top-level directory (${path.basename(root)})` : target}`, target);
    const sources = [MANIFEST];
    const notCarried: string[] = [];
    const manifest = readYaml(manifestFile, MANIFEST, target);
    const name = typeof manifest.name === "string" ? manifest.name : undefined;
    if (name === undefined) throw refuseImport("hermes", `${MANIFEST} has no name; Hermes requires one`, target);
    const description = typeof manifest.description === "string" ? manifest.description : "";
    const seatId = EXPORTED_SEAT.exec(description)?.[1];
    const agentId = agentIdFrom("hermes", seatId ?? name, target);
    for (const key of Object.keys(manifest)) {
      if (["name", "version", "description", "distribution_owned"].includes(key)) continue;
      notCarried.push(`${MANIFEST} ${key}: Hermes's own field (${key === "env_requires" ? "the env names a Hermes host needs; Trent reads its own secrets" : "no Trent equivalent"})`);
    }

    const soulFile = path.join(root, SOUL);
    let prompt = "";
    if (fs.existsSync(soulFile)) {
      sources.push(SOUL);
      const seat = seatPromptOf(fs.readFileSync(soulFile, "utf8"));
      prompt = seat.prompt;
      if (seat.exported) notCarried.push(`${SOUL}: the approval rules and skills index are Trent's own rendering and are regenerated on export, not stored in the prompt`);
    } else notCarried.push(`${SOUL}: absent, so the prompt is empty until a person writes one`);

    const configFile = path.join(root, CONFIG);
    const config = fs.existsSync(configFile) ? readYaml(configFile, CONFIG, target) : {};
    if (fs.existsSync(configFile)) sources.push(CONFIG);
    else notCarried.push(`${CONFIG}: absent, so no toolset is granted until a person sets them`);
    const allowed = hermesToolsets(configuredToolsets(config));
    const denied = hermesToolsets(isRecord(config.agent) ? strings(config.agent.disabled_toolsets) : []);
    for (const toolset of allowed.unmapped) notCarried.push(`${CONFIG} toolset "${toolset}": Hermes has it and Trent does not; not mapped`);
    for (const toolset of denied.unmapped) notCarried.push(`${CONFIG} disabled_toolsets "${toolset}": Hermes has it and Trent does not; not mapped`);
    if (isRecord(config.model)) notCarried.push(`${CONFIG} model: ${JSON.stringify(config.model)} (the model tier is left unset)`);
    for (const key of Object.keys(config)) {
      if (["toolsets", "platform_toolsets", "agent", "mcp_servers", "model"].includes(key)) continue;
      notCarried.push(`${CONFIG} ${key}: Hermes's own setting; no Trent equivalent`);
    }

    const mcpServers = readServers(config, root, sources, notCarried);
    const grants = resolveGrants([...allowed.toolsets, ...(mcpServers.length > 0 ? ["mcp"] : [])], denied.toolsets);
    notCarried.push(...grants.notes);
    const skills = readSkillTree(path.join(root, SKILLS_DIR), root, notCarried);
    sources.push(...skills.map((s) => s.source));
    return { format: "hermes", agentId, name, description, prompt, toolsets: grants.toolsets, denied: grants.denied, skills, mcpServers, notCarried, sources, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
