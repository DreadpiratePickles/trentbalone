/**
 * The SKILL.md frontmatter parser and renderer (`skill-store.ts` reads and writes through them).
 *
 * One line per field, plus the two shapes the Agent Skills specification and Hermes use and the
 * old line-by-line reader mangled: an indentation-nested map, which reads as dotted keys
 * (`metadata.trent.trust`) and renders back as the same block, and a block list under a key
 * (`- item` lines), which reads as the comma-joined string every list field here already uses.
 * A quoted scalar is its content. Nothing here touches the disk.
 */

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * [U5] The vendor namespace Trent's own fields travel under when a skill leaves for another
 * harness (Agent Skills `metadata`, Hermes `metadata.hermes`): `metadata.trent.<field>` is read as
 * the store's flat `<field>` when the flat one is absent, so trust, status and provenance survive
 * an export and a re-import. A flat field always wins over the nested copy.
 */
const TRENT_METADATA_PREFIX = "metadata.trent.";

/**
 * Frontmatter is one line per field, plus indentation-nested maps, which read as dotted keys
 * (`metadata.trent.trust`) and render back as the same block. A block list under a key
 * (`- item` lines) reads as the comma-joined string every list field here already uses.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  // The open map keys by indentation depth: `path[d]` is the key that owns indentation level d.
  const path: string[] = [];
  const indents: number[] = [];
  let listKey: string | undefined;
  for (const line of m[1]!.split("\n")) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    while (indents.length > 0 && indent <= indents[indents.length - 1]!) {
      indents.pop();
      path.pop();
    }
    const content = line.trim();
    if (content.startsWith("- ") && listKey !== undefined) {
      const item = unquote(content.slice(2).trim());
      fields[listKey] = fields[listKey] === "" || fields[listKey] === undefined ? item : `${fields[listKey]}, ${item}`;
      continue;
    }
    listKey = undefined;
    const idx = content.indexOf(":");
    if (idx <= 0) continue;
    const key = [...path, content.slice(0, idx).trim()].join(".");
    const value = unquote(content.slice(idx + 1).trim());
    if (value === "") {
      // A key with nothing after the colon opens a nested map, or a block list.
      path.push(content.slice(0, idx).trim());
      indents.push(indent);
      listKey = key;
      fields[key] = "";
      continue;
    }
    fields[key] = value;
  }
  for (const key of Object.keys(fields)) {
    // An opened map that got children is not a field of its own.
    if (fields[key] === "" && Object.keys(fields).some((other) => other.startsWith(`${key}.`))) delete fields[key];
  }
  for (const key of Object.keys(fields)) {
    if (!key.startsWith(TRENT_METADATA_PREFIX)) continue;
    const flat = key.slice(TRENT_METADATA_PREFIX.length);
    if (fields[flat] === undefined) fields[flat] = fields[key]!;
    delete fields[key];
  }
  return { fields, body: text.slice(m[0].length) };
}

/** A YAML-quoted scalar is its content: one matching pair of outer quotes comes off. */
function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) return value.slice(1, -1);
  return value;
}

/** Renders the fields; a dotted key becomes the nested block `parseFrontmatter` read it from. */
export function renderFrontmatter(fields: Record<string, string>, body: string): string {
  const lines: string[] = [];
  const opened: string[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    const value = raw.replace(/\n/g, " ");
    const parts = key.split(".");
    const leaf = parts.pop()!;
    // Close the maps this key is not inside, then open the ones it needs, shallowest first.
    while (opened.length > 0 && opened.some((name, depth) => parts[depth] !== name)) opened.pop();
    for (let depth = opened.length; depth < parts.length; depth += 1) {
      lines.push(`${"  ".repeat(depth)}${parts[depth]}:`);
      opened.push(parts[depth]!);
    }
    lines.push(`${"  ".repeat(parts.length)}${leaf}: ${value}`);
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

