import { describe, expect, it } from "vitest";
import { parseAllowedEvalEnvContent } from "@/lib/eval-env-file";

describe("eval env file parsing", () => {
  it("parses plain text env lines with quotes", () => {
    const entries = parseAllowedEvalEnvContent([
      "DAYTONA_TARGET='us'",
      "IGNORED_SECRET=do-not-load",
      "E2B_TEMPLATE=base",
    ].join("\n"), (key) => key === "DAYTONA_TARGET" || key === "E2B_TEMPLATE");

    expect(entries).toEqual([
      ["DAYTONA_TARGET", "us"],
      ["E2B_TEMPLATE", "base"],
    ]);
  });

  it("strips RTF hyperlink markup and trailing RTF slashes from eval values", () => {
    const content = [
      'DAYTONA_API_URL={\\field{\\*\\fldinst{HYPERLINK "https://app.daytona.io/api"}}{\\fldrslt \\ul https://app.daytona.io/api}}\\',
      "DAYTONA_TARGET=us\\",
      "DAYTONA_API_KEY=daytona_test_key\\",
    ].join("\n");

    const entries = parseAllowedEvalEnvContent(content, (key) => key.startsWith("DAYTONA_"));

    expect(entries).toEqual([
      ["DAYTONA_API_URL", "https://app.daytona.io/api"],
      ["DAYTONA_TARGET", "us"],
      ["DAYTONA_API_KEY", "daytona_test_key"],
    ]);
  });
});
