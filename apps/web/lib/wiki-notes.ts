/**
 * Trent Wiki (Obsidian-style) — notes, folders, backlinks, uploads, graph.
 *
 * Storage: piggybacks on the existing `documents` store with a structured
 * `source` field of the form `wiki:/folder/sub/note-slug.md`. The path
 * lives in the source, the markdown content + title in the standard fields.
 *
 * Backlinks: parsed from `[[note-title]]` references in content.
 * Tags: parsed from `#tag` tokens.
 */

import { store } from "@/lib/store";
import type { Document } from "@/lib/types";
import { indexNote, removeNote } from "@/lib/wiki-embeddings";

export type WikiNoteSummary = {
  id: string;
  path: string;          // "/folder/sub/note.md"
  folder: string;        // "/folder/sub"
  slug: string;          // "note"
  title: string;
  excerpt: string;
  tags: string[];
  outgoing: string[];
  backlinks: string[];
  updatedAt: string;
  contentLength: number;
};

export type WikiNote = WikiNoteSummary & { content: string };

export type WikiTreeNode = {
  name: string;
  path: string;
  kind: "folder" | "note";
  children: WikiTreeNode[];
  noteId?: string;
  noteTitle?: string;
};

export type WikiGraph = {
  nodes: Array<{ id: string; title: string; degree: number }>;
  edges: Array<{ from: string; to: string }>;
};

const WIKI_SOURCE_PREFIX = "wiki:";

export function slugify(s: string) {
  return s.toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9\-/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizePath(input: string): string {
  let p = (input || "/untitled").trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.endsWith(".md")) p = `${p}.md`;
  // Collapse double slashes
  p = p.replace(/\/+/g, "/");
  return p;
}

export function folderOf(path: string): string {
  const dir = path.substring(0, path.lastIndexOf("/"));
  return dir || "/";
}

export function slugOf(path: string): string {
  const name = path.substring(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "");
}

export function extractTags(content: string): string[] {
  const set = new Set<string>();
  const re = /(?:^|\s)#([a-zA-Z][\w-]{1,30})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) set.add(m[1]);
  return Array.from(set);
}

export function extractWikiLinks(content: string): string[] {
  const set = new Set<string>();
  const re = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const target = m[1].trim();
    if (target) set.add(target);
  }
  return Array.from(set);
}

function isWikiDoc(doc: Document): boolean {
  return typeof doc.source === "string" && doc.source.startsWith(WIKI_SOURCE_PREFIX);
}

function pathFromDoc(doc: Document): string {
  return doc.source.slice(WIKI_SOURCE_PREFIX.length) || `/${slugify(doc.title)}.md`;
}

function summarize(doc: Document, allDocs: Document[]): WikiNoteSummary {
  const path = pathFromDoc(doc);
  const outgoing = extractWikiLinks(doc.content);
  const tags = extractTags(doc.content);
  const backlinks = allDocs
    .filter((d) => d.id !== doc.id && isWikiDoc(d))
    .filter((d) => extractWikiLinks(d.content).some((t) => t.toLowerCase() === doc.title.toLowerCase()))
    .map((d) => d.title);

  return {
    id: doc.id,
    path,
    folder: folderOf(path),
    slug: slugOf(path),
    title: doc.title,
    excerpt: doc.content.replace(/\s+/g, " ").slice(0, 240),
    tags,
    outgoing,
    backlinks,
    updatedAt: doc.createdAt,
    contentLength: doc.content.length,
  };
}

export async function listWikiNotes(companyId: string): Promise<WikiNoteSummary[]> {
  const docs = await store.listDocuments(companyId);
  const wikiDocs = docs.filter(isWikiDoc);
  return wikiDocs.map((d) => summarize(d, wikiDocs)).sort((a, b) => a.path.localeCompare(b.path));
}

export async function getWikiNote(companyId: string, idOrPath: string): Promise<WikiNote | null> {
  const docs = await store.listDocuments(companyId);
  const wikiDocs = docs.filter(isWikiDoc);
  let doc =
    wikiDocs.find((d) => d.id === idOrPath) ||
    wikiDocs.find((d) => pathFromDoc(d) === normalizePath(idOrPath)) ||
    wikiDocs.find((d) => d.title.toLowerCase() === idOrPath.toLowerCase());
  if (!doc) return null;
  return { ...summarize(doc, wikiDocs), content: doc.content };
}

export async function buildWikiTree(companyId: string): Promise<WikiTreeNode> {
  const notes = await listWikiNotes(companyId);
  const root: WikiTreeNode = { name: "/", path: "/", kind: "folder", children: [] };

  for (const note of notes) {
    const parts = note.path.split("/").filter(Boolean); // ["folder", "sub", "note.md"]
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const partPath = `/${parts.slice(0, i + 1).join("/")}`;
      let child = parent.children.find((c) => c.kind === "folder" && c.path === partPath);
      if (!child) {
        child = { name: parts[i], path: partPath, kind: "folder", children: [] };
        parent.children.push(child);
      }
      parent = child;
    }
    parent.children.push({
      name: parts[parts.length - 1].replace(/\.md$/i, ""),
      path: `${note.path}#${note.id}`,
      kind: "note",
      children: [],
      noteId: note.id,
      noteTitle: note.title,
    });
  }

  // Sort children alphabetically; folders first
  function sortRec(node: WikiTreeNode) {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortRec);
  }
  sortRec(root);
  return root;
}

export async function buildGraph(companyId: string): Promise<WikiGraph> {
  const notes = await listWikiNotes(companyId);
  const titleIndex = new Map(notes.map((n) => [n.title.toLowerCase(), n]));
  const edges: WikiGraph["edges"] = [];
  for (const n of notes) {
    for (const target of n.outgoing) {
      const tgt = titleIndex.get(target.toLowerCase());
      if (tgt) edges.push({ from: n.id, to: tgt.id });
    }
  }
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  return {
    nodes: notes.map((n) => ({ id: n.id, title: n.title, degree: degree.get(n.id) ?? 0 })),
    edges,
  };
}

export async function createOrUpdateWikiNote(input: {
  companyId: string;
  id?: string;
  path: string;
  title: string;
  content: string;
}): Promise<WikiNote> {
  const path = normalizePath(input.path);

  if (input.id) {
    const existing = await store.listDocuments(input.companyId).then((docs) => docs.find((d) => d.id === input.id));
    if (existing) {
      // Update title/content. We also need to rewrite source if path changed.
      const updated = await store.updateDocument(existing.id, {
        title: input.title,
        content: input.content,
      });
      if (updated && pathFromDoc(updated) !== path) {
        // mem store doesn't expose direct source update; mutate snapshot for in-memory case.
        try {
          const snap = (store as unknown as { snapshot?: () => { documents: Document[] } }).snapshot?.();
          const found = snap?.documents.find((d) => d.id === updated.id);
          if (found) found.source = `${WIKI_SOURCE_PREFIX}${path}`;
        } catch {
          /* prisma path: best-effort skip */
        }
      }
    }
  } else {
    await store.createDocument({
      companyId: input.companyId,
      type: "research",
      title: input.title,
      content: input.content,
      source: `${WIKI_SOURCE_PREFIX}${path}`,
      version: 1,
      memoryTier: "semantic",
    });
  }

  const fresh = await getWikiNote(input.companyId, path);
  // Best-effort: index the note's content into the vector store.
  if (fresh) {
    void indexNote({
      companyId: input.companyId,
      noteId: fresh.id,
      title: fresh.title,
      path: fresh.path,
      content: input.content,
    }).catch((err) => console.warn("wiki-notes: index failed", err instanceof Error ? err.message : err));
  }
  return fresh!;
}

export async function deleteWikiNote(companyId: string, id: string): Promise<boolean> {
  try {
    const snap = (store as unknown as { snapshot?: () => { documents: Document[] } }).snapshot?.();
    if (!snap) return false;
    const idx = snap.documents.findIndex((d) => d.id === id && d.companyId === companyId);
    if (idx === -1) return false;
    snap.documents.splice(idx, 1);
    void removeNote(id).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
