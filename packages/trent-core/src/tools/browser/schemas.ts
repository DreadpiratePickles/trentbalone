/**
 * Hermes's `browser_*` schemas (`~/.hermes/hermes-agent/tools/browser_tool.py:437-577`), as data
 * so the seat prompt can render them, plus two Trent additions: `browser_screenshot` (the PNG
 * path with no model call) and `browser_get_text` (plain page text under the spillover rule).
 * The Hermes descriptions are condensed; the names, keys and required lists are theirs.
 */
import type { ToolSchema } from "../web/schemas.js";

/** Hermes `browser_snapshot`: snapshots over this are truncated and saved whole to a file. */
export const SNAPSHOT_LIMIT = 15_000;
/** Pixels scrolled per `browser_scroll` call (Hermes scrolls one viewport; this is a fixed step). */
export const SCROLL_STEP = 600;
export const NAVIGATION_TIMEOUT_MS = 30_000;
export const ACTION_TIMEOUT_MS = 10_000;
export const MAX_CONSOLE_MESSAGES = 200;
export const MAX_IMAGES = 100;

const REQUIRES_NAVIGATE = "Requires browser_navigate first.";

export const BROWSER_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "browser_navigate",
    description:
      "Navigate to a URL in the browser. Initializes the session and loads the page; must be called before " +
      "other browser tools. For plain information retrieval prefer web_search or web_extract (faster, cheaper); " +
      "use the browser when you need to interact with a page (click, fill forms, dynamic content). Returns a " +
      "compact snapshot with interactive elements and ref IDs. Private, loopback and cloud-metadata addresses " +
      "and non-http(s) schemes are always refused.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The URL to navigate to (e.g. 'https://example.com')." } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Text snapshot of the current page: interactive elements with ref IDs (@e1, @e2) for browser_click and " +
      `browser_type. full=false (default) is the compact view; full=true adds the page text. Over ${SNAPSHOT_LIMIT} ` +
      `chars the snapshot is truncated and saved whole to a file you can page with read_file. ${REQUIRES_NAVIGATE}`,
    parameters: {
      type: "object",
      properties: { full: { type: "boolean", description: "true for complete page content; false (default) for interactive elements only." } },
      required: [],
    },
  },
  {
    name: "browser_click",
    description: `Click the element with the given ref ID from the snapshot (e.g. '@e5'). ${REQUIRES_NAVIGATE}`,
    parameters: {
      type: "object",
      properties: { ref: { type: "string", description: "The element reference from the snapshot (e.g. '@e5')." } },
      required: ["ref"],
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into the input identified by its ref ID: clears the field first, then types. Password fields " +
      `are always refused; the human types secrets. ${REQUIRES_NAVIGATE}`,
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "The element reference from the snapshot (e.g. '@e3')." },
        text: { type: "string", description: "The text to type into the field." },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "browser_scroll",
    description: `Scroll the page up or down to reveal more content. ${REQUIRES_NAVIGATE}`,
    parameters: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down"], description: "Direction to scroll." } },
      required: ["direction"],
    },
  },
  {
    name: "browser_back",
    description: `Go back to the previous page in history. ${REQUIRES_NAVIGATE}`,
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_press",
    description: `Press a keyboard key: Enter to submit, Tab to move, Escape, ArrowDown. ${REQUIRES_NAVIGATE}`,
    parameters: {
      type: "object",
      properties: { key: { type: "string", description: "Key to press (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown')." } },
      required: ["key"],
    },
  },
  {
    name: "browser_get_images",
    description: `List the images on the current page with their URLs and alt text, for vision_analyze. ${REQUIRES_NAVIGATE}`,
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "browser_vision",
    description:
      "Screenshot the current page and ask the vision model a question about it: for CAPTCHAs, visual " +
      "verification, complex layouts, or when the text snapshot misses something visual. Returns the analysis " +
      `and a screenshot_path. ${REQUIRES_NAVIGATE}`,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "What you want to know about the page visually. Be specific." },
        annotate: { type: "boolean", description: "If true, overlay numbered [N] labels on interactive elements; [N] maps to @eN." },
      },
      required: ["question"],
    },
  },
  {
    name: "browser_console",
    description:
      "Console output and uncaught JavaScript errors since navigation. With 'expression', evaluates JavaScript " +
      `in the page and returns the JSON-serialised result. ${REQUIRES_NAVIGATE}`,
    parameters: {
      type: "object",
      properties: {
        clear: { type: "boolean", description: "If true, clear the message buffer after reading." },
        expression: { type: "string", description: "JavaScript to evaluate in the page (e.g. 'document.title')." },
      },
      required: [],
    },
  },
  {
    name: "browser_screenshot",
    description: `Save a PNG screenshot of the current page and return its path (no model call). ${REQUIRES_NAVIGATE}`,
    parameters: {
      type: "object",
      properties: { full_page: { type: "boolean", description: "If true, capture the whole scrollable page." } },
      required: [],
    },
  },
  {
    name: "browser_get_text",
    description:
      `Plain visible text of the current page, capped at ${SNAPSHOT_LIMIT} chars with the full text saved to a ` +
      `file you can page with read_file. ${REQUIRES_NAVIGATE}`,
    parameters: { type: "object", properties: {}, required: [] },
  },
];
