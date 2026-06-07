/**
 * workbench-artifact-parser.ts
 *
 * Parses the <boltArtifact> / <boltAction> XML format that the build agent streams.
 * Works on a complete accumulated string (call parseArtifact after stream ends / on
 * each continuation segment). Also exports a streaming helper that can fire callbacks
 * as actions close, enabling incremental execution.
 *
 * Ported from bolt.diy's message-parser design, adapted for Trent's server-side context.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type FileAction  = { type: "file";  filePath: string; content: string };
export type EditAction  = { type: "edit";  filePath: string; content: string };
export type ShellAction = { type: "shell"; command: string };
export type StartAction = { type: "start"; command: string };
export type ArtifactAction = FileAction | EditAction | ShellAction | StartAction;

export type ParsedArtifact = {
  id:      string;
  title:   string;
  actions: ArtifactAction[];
};

// ── parseArtifact — full-string parser ────────────────────────────────────────

/**
 * Extract all actions from a complete or partial LLM response.
 * Returns null when no <boltArtifact> opening tag is found.
 * Partial actions (stream truncated mid-tag) are silently dropped.
 */
export function parseArtifact(text: string): ParsedArtifact | null {
  const artifactOpen = /<boltArtifact([^>]*)>/i.exec(text);
  if (!artifactOpen) return null;

  const attrs  = artifactOpen[1];
  const id     = attrVal(attrs, "id")    ?? "artifact";
  const title  = attrVal(attrs, "title") ?? "App";
  const body   = text.slice(artifactOpen.index + artifactOpen[0].length);
  const actions: ArtifactAction[] = [];

  // Match complete <boltAction>…</boltAction> blocks only.
  const actionRe = /<boltAction([^>]*)>([\s\S]*?)<\/boltAction>/gi;
  let m: RegExpExecArray | null;
  while ((m = actionRe.exec(body)) !== null) {
    const actionAttrs = m[1];
    const content     = decodeHtmlEntities(m[2].trim());
    const type        = attrVal(actionAttrs, "type") ?? "shell";

    if (type === "file") {
      const filePath = attrVal(actionAttrs, "filePath");
      if (filePath) actions.push({ type: "file", filePath, content });
    } else if (type === "edit") {
      const filePath = attrVal(actionAttrs, "filePath");
      if (filePath) actions.push({ type: "edit", filePath, content });
    } else if (type === "start") {
      actions.push({ type: "start", command: content });
    } else {
      // "shell" and anything else
      actions.push({ type: "shell", command: content });
    }
  }

  return { id, title, actions };
}

// ── StreamingArtifactParser — incremental parser for live streaming ───────────

export type ActionTypeMeta =
  | { type: "file";  filePath: string }
  | { type: "edit";  filePath: string }
  | { type: "shell" }
  | { type: "start" };

export type StreamParserCallbacks = {
  onArtifactOpen?:  (meta: { id: string; title: string }) => void;
  onArtifactClose?: (meta: { id: string; title: string }) => void;
  onActionOpen?:    (action: ActionTypeMeta) => void;
  /** Fired with each incremental chunk while content is streaming. */
  onActionContent?: (chunk: string) => void;
  onActionClose?:   (action: ArtifactAction) => void;
};

type StreamState = "idle" | "in_artifact" | "in_action";

/**
 * Incremental streaming parser. Push tokens as they arrive; flush() when the
 * stream ends to handle any unclosed final action.
 */
export function createStreamingArtifactParser(callbacks: StreamParserCallbacks) {
  let buf    = "";
  let state: StreamState = "idle";
  let artifactMeta: { id: string; title: string } | null = null;
  let actionMeta:   ActionTypeMeta | null = null;
  let actionBuf  = "";

  function push(chunk: string) {
    buf += chunk;
    process();
  }

  function flush() {
    if (state === "in_action" && actionMeta) {
      const action = finaliseAction(actionMeta, actionBuf.trim());
      if (action) callbacks.onActionClose?.(action);
    }
    if (artifactMeta) callbacks.onArtifactClose?.(artifactMeta);
  }

  function process() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (state === "idle") {
        const idx = buf.indexOf("<boltArtifact");
        if (idx === -1) { buf = buf.slice(-60); return; }
        const end = buf.indexOf(">", idx);
        if (end === -1) return;
        const tag = buf.slice(idx, end + 1);
        artifactMeta = { id: attrVal(tag, "id") ?? "artifact", title: attrVal(tag, "title") ?? "App" };
        callbacks.onArtifactOpen?.(artifactMeta);
        state = "in_artifact";
        buf = buf.slice(end + 1);

      } else if (state === "in_artifact") {
        const closeArt = buf.indexOf("</boltArtifact>");
        const openAct  = buf.indexOf("<boltAction");
        if (closeArt !== -1 && (openAct === -1 || closeArt < openAct)) {
          if (artifactMeta) callbacks.onArtifactClose?.(artifactMeta);
          state = "idle"; artifactMeta = null;
          buf = buf.slice(closeArt + "</boltArtifact>".length);
          continue;
        }
        if (openAct === -1) { buf = buf.slice(-120); return; }
        const end = buf.indexOf(">", openAct);
        if (end === -1) return;
        const tag  = buf.slice(openAct, end + 1);
        const type = attrVal(tag, "type") ?? "shell";
        const meta: ActionTypeMeta = type === "file"
          ? { type: "file",  filePath: attrVal(tag, "filePath") ?? "unknown" }
          : type === "edit"
          ? { type: "edit",  filePath: attrVal(tag, "filePath") ?? "unknown" }
          : type === "start"
          ? { type: "start" }
          : { type: "shell" };
        actionMeta = meta;
        callbacks.onActionOpen?.(actionMeta);
        actionBuf = "";
        state = "in_action";
        buf = buf.slice(end + 1);

      } else if (state === "in_action") {
        const closeAct = buf.indexOf("</boltAction>");
        if (closeAct === -1) {
          // Stream the safe part (keep tail in case </boltAction> is split).
          const safe = buf.length > 14 ? buf.slice(0, buf.length - 14) : "";
          if (safe) { callbacks.onActionContent?.(safe); actionBuf += safe; buf = buf.slice(safe.length); }
          return;
        }
        const remaining = buf.slice(0, closeAct);
        if (remaining) { callbacks.onActionContent?.(remaining); actionBuf += remaining; }
        if (actionMeta) {
          const action = finaliseAction(actionMeta, actionBuf.trim());
          if (action) callbacks.onActionClose?.(action);
        }
        actionMeta = null; actionBuf = ""; state = "in_artifact";
        buf = buf.slice(closeAct + "</boltAction>".length);
      }
    }
  }

  return { push, flush };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function attrVal(text: string, name: string): string | undefined {
  return text.match(new RegExp(`${name}=["']([^"']*?)["']`, "i"))?.[1];
}

/**
 * Decode the HTML entities a model commonly emits when it over-escapes code
 * inside the XML wrapper (e.g. `useState&lt;Note&gt;` for `useState<Note>`).
 * Without this the entities are written verbatim, producing invalid source
 * that never compiles. `&amp;` is decoded last so `&amp;lt;` → `&lt;`, not `<`.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#0*34;/g, "\"")
    .replace(/&#x0*22;/gi, "\"")
    .replace(/&amp;/g, "&");
}

function finaliseAction(meta: ActionTypeMeta, rawText: string): ArtifactAction | null {
  const text = decodeHtmlEntities(rawText);
  if (meta.type === "file")  return { type: "file",  filePath: meta.filePath, content: text };
  if (meta.type === "edit")  return { type: "edit",  filePath: meta.filePath, content: text };
  if (meta.type === "start") return { type: "start", command: text };
  if (meta.type === "shell") return { type: "shell", command: text };
  return null;
}
