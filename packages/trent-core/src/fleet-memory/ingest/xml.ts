/**
 * A small XML reader for office parts: elements, attributes, text, entities. Not a validating
 * parser and not meant to be one: `word/document.xml` and `xl/worksheets/sheet1.xml` are
 * machine-written, well-formed, and the two extractors only walk a handful of element names.
 * Comments, processing instructions, CDATA and DOCTYPE are handled so a hand-edited file does
 * not trip it. Namespace prefixes are kept as written (`w:p`, `w:val`).
 */

export interface XmlNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly (XmlNode | string)[];
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

const ATTRIBUTE_RE = /([^\s=\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of body.matchAll(ATTRIBUTE_RE)) attrs[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
  return attrs;
}

/** The index just past the `>` that closes the tag opened at `start`, honouring quoted values. */
function tagEnd(text: string, start: number): number {
  let quote: string | undefined;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }
  throw new Error("malformed XML: an unterminated tag");
}

interface Open {
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly children: (XmlNode | string)[];
}

/** Parse a document into a synthetic root whose children are the top-level nodes. */
export function parseXml(text: string): XmlNode {
  const root: Open = { name: "", attrs: {}, children: [] };
  const stack: Open[] = [root];
  let at = 0;
  while (at < text.length) {
    const lt = text.indexOf("<", at);
    if (lt === -1) {
      const tail = text.slice(at);
      if (tail.trim() !== "") stack[stack.length - 1]!.children.push(decodeEntities(tail));
      break;
    }
    if (lt > at) {
      const chunk = text.slice(at, lt);
      if (chunk.trim() !== "" || stack.length > 1) stack[stack.length - 1]!.children.push(decodeEntities(chunk));
    }
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      at = close === -1 ? text.length : close + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const close = text.indexOf("]]>", lt + 9);
      const body = text.slice(lt + 9, close === -1 ? text.length : close);
      stack[stack.length - 1]!.children.push(body);
      at = close === -1 ? text.length : close + 3;
      continue;
    }
    if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
      at = tagEnd(text, lt);
      continue;
    }
    const end = tagEnd(text, lt);
    const inner = text.slice(lt + 1, end - 1).trim();
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      // Pop to the matching open element; a stray close tag is ignored rather than fatal.
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]!.name === name) {
          stack.length = depth;
          break;
        }
      }
      at = end;
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = body.search(/[\s\/]/);
    const name = nameEnd === -1 ? body : body.slice(0, nameEnd);
    const node: Open = { name, attrs: nameEnd === -1 ? {} : parseAttributes(body.slice(nameEnd)), children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
    at = end;
  }
  return root;
}

export function childElements(node: XmlNode, name?: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (name === undefined || child.name === name) out.push(child);
  }
  return out;
}

/** The first descendant with `name`, depth first. */
export function findElement(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.name === name) return child;
    const nested = findElement(child, name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Every descendant with `name`, in document order. */
export function findElements(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.name === name) out.push(child);
    findElements(child, name, out);
  }
  return out;
}

/** All text under a node, concatenated in order. */
export function textOf(node: XmlNode): string {
  let out = "";
  for (const child of node.children) out += typeof child === "string" ? child : textOf(child);
  return out;
}
