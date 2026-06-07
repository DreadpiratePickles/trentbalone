import { describe, expect, it } from "vitest";
import {
  parseArtifact,
  createStreamingArtifactParser,
  type ArtifactAction,
  type EditAction,
  type FileAction,
} from "@/lib/workbench-artifact-parser";

function fileAction(actions: ArtifactAction[] | undefined): FileAction | undefined {
  return actions?.find((a): a is FileAction => a.type === "file");
}

function editAction(actions: ArtifactAction[] | undefined): EditAction | undefined {
  return actions?.find((a): a is EditAction => a.type === "edit");
}

describe("parseArtifact edit actions", () => {
  it("parses type=edit with search/replace body", () => {
    const body = [
      "<<<<<<< SEARCH",
      "const broken = true;",
      "=======",
      "const broken = false;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const text =
      `<boltArtifact id="x" title="X">` +
      `<boltAction type="edit" filePath="src/Broken.tsx">${body}</boltAction>` +
      `</boltArtifact>`;
    const parsed = parseArtifact(text);
    expect(editAction(parsed?.actions)).toEqual({
      type: "edit",
      filePath: "src/Broken.tsx",
      content: body,
    });
  });
});

describe("parseArtifact HTML entity decoding", () => {
  it("decodes angle brackets so generated TSX is valid", () => {
    // The model sometimes over-escapes code inside the XML wrapper, emitting
    // &lt;/&gt; instead of </>. Written verbatim that is invalid TypeScript.
    const text = [
      `<boltArtifact id="x" title="X">`,
      `<boltAction type="file" filePath="src/App.tsx">`,
      `const x = useState&lt;Note[]&gt;(() =&gt; load())`,
      `</boltAction>`,
      `</boltArtifact>`,
    ].join("\n");
    const parsed = parseArtifact(text);
    expect(fileAction(parsed?.actions)?.content).toBe(
      "const x = useState<Note[]>(() => load())",
    );
  });

  it("decodes &amp; last to avoid double-decoding", () => {
    const text =
      `<boltArtifact id="x" title="X">` +
      `<boltAction type="file" filePath="a.ts">a &amp;&amp; b</boltAction>` +
      `</boltArtifact>`;
    const parsed = parseArtifact(text);
    expect(fileAction(parsed?.actions)?.content).toBe("a && b");
  });

  it("decodes quotes and apostrophes", () => {
    const text =
      `<boltArtifact id="x" title="X">` +
      `<boltAction type="file" filePath="a.ts">const s = &quot;hi&quot; + &#39;yo&#39;</boltAction>` +
      `</boltArtifact>`;
    const parsed = parseArtifact(text);
    expect(fileAction(parsed?.actions)?.content).toBe(`const s = "hi" + 'yo'`);
  });

  it("leaves already-raw code untouched", () => {
    const text =
      `<boltArtifact id="x" title="X">` +
      `<boltAction type="file" filePath="a.ts">const x = useState<Note>(() => 1)</boltAction>` +
      `</boltArtifact>`;
    const parsed = parseArtifact(text);
    expect(fileAction(parsed?.actions)?.content).toBe("const x = useState<Note>(() => 1)");
  });
});

describe("createStreamingArtifactParser HTML entity decoding", () => {
  it("decodes entities in the finalised file action", () => {
    const closed: ArtifactAction[] = [];
    const parser = createStreamingArtifactParser({ onActionClose: (a) => closed.push(a) });
    parser.push(`<boltArtifact id="x" title="X"><boltAction type="file" filePath="src/App.tsx">`);
    parser.push(`useState&lt;Note&gt;()`);
    parser.push(`</boltAction></boltArtifact>`);
    parser.flush();
    expect(fileAction(closed)?.content).toBe("useState<Note>()");
  });
});
