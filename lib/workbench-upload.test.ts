import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  DEFAULT_UPLOAD_LIMITS,
  expandUploads,
  isProbablyText,
  sanitizeUploadPath,
  summarizeUpload,
} from "@/lib/workbench-upload";

const text = (s: string) => strToU8(s);

describe("sanitizeUploadPath", () => {
  it("accepts plain and nested relative paths", () => {
    expect(sanitizeUploadPath("customers.csv")).toBe("customers.csv");
    expect(sanitizeUploadPath("docs/roadmap.md")).toBe("docs/roadmap.md");
    expect(sanitizeUploadPath("./a/b.txt")).toBe("a/b.txt");
  });
  it("rejects traversal, absolute, and drive paths (tester requirement)", () => {
    expect(sanitizeUploadPath("../secrets.env")).toBeNull();
    expect(sanitizeUploadPath("a/../../b.txt")).toBeNull();
    expect(sanitizeUploadPath("/etc/passwd")).toBeNull();
    expect(sanitizeUploadPath("C:\\windows\\x.txt")).toBeNull();
    expect(sanitizeUploadPath("")).toBeNull();
  });
  it("normalizes backslashes", () => {
    expect(sanitizeUploadPath("folder\\file.md")).toBe("folder/file.md");
  });
});

describe("isProbablyText", () => {
  it("treats known extensions as text", () => {
    expect(isProbablyText(new Uint8Array([0, 1, 2]), "data.csv")).toBe(true);
  });
  it("detects binary content by NUL bytes", () => {
    expect(isProbablyText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]), "image.png")).toBe(false);
  });
});

describe("expandUploads", () => {
  it("writes single files at their sanitized path", () => {
    const { entries, errors } = expandUploads([{ name: "customers.csv", bytes: text("id,name\n1,a") }]);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: "customers.csv", status: "ok", source: "file" });
    expect(entries[0].content).toContain("id,name");
  });

  it("preserves folder structure from relativePath", () => {
    const { entries } = expandUploads([
      { name: "roadmap.md", relativePath: "docs/roadmap.md", bytes: text("# Roadmap") },
    ]);
    expect(entries[0].path).toBe("docs/roadmap.md");
  });

  it("extracts zip archives preserving nested paths", () => {
    const zipped = zipSync({
      "data/customers.csv": text("id\n1"),
      "notes/readme.md": text("# hi"),
    });
    const { entries, errors } = expandUploads([{ name: "bundle.zip", bytes: zipped }]);
    expect(errors).toEqual([]);
    const paths = entries.filter((e) => e.status === "ok").map((e) => e.path).sort();
    expect(paths).toEqual(["data/customers.csv", "notes/readme.md"]);
    expect(entries.every((e) => e.source === "zip")).toBe(true);
  });

  it("rejects zip members with path traversal (tester requirement)", () => {
    const zipped = zipSync({ "../evil.env": text("SECRET=1"), "ok.md": text("fine") });
    const { entries } = expandUploads([{ name: "bundle.zip", bytes: zipped }]);
    const evil = entries.find((e) => e.path.includes("evil"));
    expect(evil?.status).toBe("skipped");
    expect(evil?.reason).toContain("unsafe path");
    expect(entries.find((e) => e.path === "ok.md")?.status).toBe("ok");
  });

  it("skips oversized files with a clear reason", () => {
    const limits = { ...DEFAULT_UPLOAD_LIMITS, maxFileBytes: 10 };
    const { entries } = expandUploads([{ name: "big.txt", bytes: text("x".repeat(50)) }], limits);
    expect(entries[0].status).toBe("skipped");
    expect(entries[0].reason).toContain("per-file limit");
  });

  it("stops at the total byte limit with an error", () => {
    const limits = { ...DEFAULT_UPLOAD_LIMITS, maxTotalBytes: 15 };
    const { entries, errors } = expandUploads([
      { name: "a.txt", bytes: text("0123456789") },
      { name: "b.txt", bytes: text("0123456789") },
    ], limits);
    expect(entries.filter((e) => e.status === "ok")).toHaveLength(1);
    expect(errors.join(" ")).toContain("total upload size limit");
  });

  it("skips binary files with an actionable reason", () => {
    const { entries } = expandUploads([{ name: "logo.png", bytes: new Uint8Array([0x89, 0x50, 0x00, 0x47]) }]);
    expect(entries[0].status).toBe("skipped");
    expect(entries[0].reason).toContain("binary");
  });
});

describe("summarizeUpload", () => {
  it("reports counts without leaking contents", () => {
    const { entries, errors } = expandUploads([
      { name: "a.md", bytes: text("hello") },
      { name: "../bad.md", bytes: text("x") },
    ]);
    const summary = summarizeUpload(entries, errors);
    expect(summary).toContain("1 file written");
    expect(summary).toContain("1 skipped");
    expect(summary).not.toContain("hello");
  });
});
