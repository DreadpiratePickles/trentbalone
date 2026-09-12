"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ActivityCodeBlock } from "@/components/agent-activity/types";
import { detectLanguage } from "@/components/agent-activity/utils";
import { useCodeStream } from "@/components/agent-activity/hooks/use-code-stream";

const DEFAULT_VISIBLE_LINES = 12;

type PrismLike = {
  highlight: (code: string, grammar: unknown, language: string) => string;
  languages: Record<string, unknown>;
};

export function CodeBlock({
  block,
  defaultCollapsed = true,
  active = false,
}: {
  block: ActivityCodeBlock;
  defaultCollapsed?: boolean;
  /** True while the agent is actively writing this block — drives the Cursor-style type-in + caret. */
  active?: boolean;
}) {
  const stream = useCodeStream(block.content, active);
  const isStreaming = active && !stream.done;

  const fullLines = useMemo(() => block.content.split("\n"), [block.content]);
  const [expanded, setExpanded] = useState(!defaultCollapsed || fullLines.length <= DEFAULT_VISIBLE_LINES);
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const language = block.language ?? detectLanguage(block.filename, block.content);
  const hiddenCount = Math.max(0, fullLines.length - DEFAULT_VISIBLE_LINES);

  // While streaming, render every revealed line (no collapse). Once settled, the
  // normal collapse-to-DEFAULT_VISIBLE_LINES behaviour applies.
  const visibleLines = isStreaming
    ? stream.text.split("\n")
    : expanded
      ? fullLines
      : fullLines.slice(0, DEFAULT_VISIBLE_LINES);

  useEffect(() => {
    let cancelled = false;
    const source = visibleLines.join("\n");
    if (block.mode === "diff") {
      setHtml(renderDiffHtml(source));
      return;
    }
    void loadHighlighter(language, source).then((highlighted) => {
      if (!cancelled) setHtml(highlighted ?? escapeHtml(source));
    });
    return () => { cancelled = true; };
  }, [visibleLines, language, block.mode]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(block.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }, [block.content]);

  // A live block caret trails the written code while the step is active — the
  // Cursor "still generating" tell. Appended into the highlighted HTML so it sits
  // exactly at the end of the last revealed character.
  const caret = active && block.mode !== "diff"
    ? '<span class="code-caret" aria-hidden="true"></span>'
    : "";
  const body = (html ?? escapeHtml(visibleLines.join("\n"))) + caret;

  return (
    <div
      className={`code-block${active ? " code-block--streaming" : ""}`}
      data-testid="code-block"
      data-streaming={isStreaming ? "true" : undefined}
    >
      <div className="code-block__header">
        {block.filename ? <span className="code-block__filename">{block.filename}</span> : <span />}
        {active ? (
          <span className="code-block__generating" aria-live="polite">
            <span className="code-block__generating-dot" aria-hidden="true" />
            writing
          </span>
        ) : (
          <span className="code-block__lang">{block.mode === "diff" ? "diff" : language}</span>
        )}
        <button type="button" className="code-block__copy" onClick={() => void copy()} aria-label="Copy code">
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="code-block__body">
        <code dangerouslySetInnerHTML={{ __html: body }} />
      </pre>
      {!isStreaming && !expanded && hiddenCount > 0 ? (
        <button type="button" className="code-block__expand" onClick={() => setExpanded(true)} aria-label={`Show ${hiddenCount} more lines`}>
          Show {hiddenCount} more line{hiddenCount === 1 ? "" : "s"}
        </button>
      ) : null}
      {!isStreaming && expanded && hiddenCount > 0 ? (
        <button type="button" className="code-block__expand" onClick={() => setExpanded(false)} aria-label="Collapse code block">
          Collapse
        </button>
      ) : null}
    </div>
  );
}

async function loadHighlighter(language: string, source: string): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    const Prism = (await import("prismjs")).default as PrismLike;
    await importLanguage(language);
    const grammar = Prism.languages[language] ?? Prism.languages.plaintext ?? Prism.languages.markup;
    return Prism.highlight(source, grammar, language);
  } catch {
    return null;
  }
}

async function importLanguage(language: string): Promise<void> {
  const loaders: Record<string, () => Promise<unknown>> = {
    typescript: () => import("prismjs/components/prism-typescript"),
    tsx: () => import("prismjs/components/prism-tsx"),
    javascript: () => import("prismjs/components/prism-javascript"),
    jsx: () => import("prismjs/components/prism-jsx"),
    json: () => import("prismjs/components/prism-json"),
    bash: () => import("prismjs/components/prism-bash"),
    python: () => import("prismjs/components/prism-python"),
    css: () => import("prismjs/components/prism-css"),
    markdown: () => import("prismjs/components/prism-markdown"),
    yaml: () => import("prismjs/components/prism-yaml"),
    sql: () => import("prismjs/components/prism-sql"),
  };
  if (loaders[language]) await loaders[language]();
  else await import("prismjs/components/prism-markup");
}

function renderDiffHtml(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return `<span class="code-block__diff-add">${escapeHtml(line)}</span>`;
      if (line.startsWith("-")) return `<span class="code-block__diff-del">${escapeHtml(line)}</span>`;
      return escapeHtml(line);
    })
    .join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
