#!/usr/bin/env node
/**
 * repo-scan.mjs — the anti-pattern checklist assertions that are pure repo scans.
 *
 * Three assertions, each traceable to a real defect in the previous effort:
 *
 *   1. NO CANNED STRING LITERALS   (checklist #1, #9, #15)
 *      The previous CLI answered "hello" with a pre-written literal and its only test
 *      asserted that literal. Any surface that ships a hard-coded model-shaped reply is a
 *      failure, not a feature.
 *
 *   2. NO INVENTED HEX COLOURS     (checklist #5)
 *      Every hex literal in a surface must appear in the `color` map of design-tokens.json.
 *      The previous app invented #8B5CF6 purple, which exists nowhere in the product.
 *
 *   3. NO EMOJI IN CLI OUTPUT      (house rule; CLI output must be pipeable and diffable)
 *      Emoji break column alignment in Ink, corrupt golden frames, and render as
 *      replacement boxes in Windows Terminal and in CI logs.
 *
 * Usage:
 *   node scripts/ci/repo-scan.mjs                  # strict: exit 1 on any violation
 *   node scripts/ci/repo-scan.mjs --report-only    # print the report, always exit 0
 *   node scripts/ci/repo-scan.mjs --only=hex       # run one assertion (canned|hex|emoji)
 *
 * There is deliberately NO suppression baseline. A baseline file is how a rule like this
 * dies: the list grows, nobody reads it, and the rule becomes decoration.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOKENS = path.join(REPO_ROOT, "01_discovery/output/design-tokens.json");

/** Surfaces the user can see. apps/web is read-only and pre-existing: out of scope. */
const SCAN_ROOTS = ["apps/cli/src", "packages/trent-core/src", "apps/desktop/src"];
const SCAN_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".jsx"]);
/** Tests may legitimately contain a canned literal as the *expected-to-be-absent* value. */
const TEST_RE = /\.(test|spec)\.[jt]sx?$/;

/**
 * Canned-response literals. Each entry is a real string the previous effort shipped, or a
 * shape that can only be a stand-in for a model call.
 */
const CANNED_PATTERNS = [
  { id: "trent-proxy-response", re: /Trent proxy response/i },
  { id: "placeholder-reply", re: /\b(?:This is a (?:mock|placeholder|canned|stub|simulated) (?:response|reply|answer))\b/i },
  { id: "lorem-ipsum", re: /\blorem ipsum\b/i },
  { id: "todo-implement-me", re: /\b(?:not implemented yet|coming soon|implement me)\b/i },
  // The two protocol servers shipped their own canned replies (harness-parity audit C.6):
  // `agent/chat` answered every editor request with `[ACP Editor Dispatch]: Processing task ...`,
  // and `POST /a2a/tasks` answered `status: "completed"` with `... resolved successfully.` —
  // both with no model and no orchestrator behind them. Both endpoints now run the real agent
  // runtime or refuse honestly; these two entries are what stops the literals coming back.
  { id: "acp-editor-dispatch", re: /ACP Editor Dispatch/i },
  { id: "a2a-resolved-successfully", re: /resolved successfully\./i },
];
// Deliberately NOT grepped: the hard-coded budget figures (checklist #14). A grep for
// `costCents = 0` cannot tell an accumulator's initial value from a fabricated total. That
// item is proven behaviourally — three turns, assert the ticker equals the sum of real
// gateway costs — not by pattern matching. A rule that cries wolf gets switched off.

// Unicode's own definition of "renders as a picture". The previous hand-rolled ranges swept up
// U+2713/U+2717 (the check and cross dingbats) and the arrows block, which are the style
// contract's designed monochrome glyphs, not emoji. This is the same test the ui suite uses.
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const EMOJI_G = new RegExp(EMOJI_RE.source, "gu");
const HEX_G = /#[0-9a-fA-F]{6}\b/g;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === "generated" || e.startsWith(".")) continue;
    const p = path.join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SCAN_EXT.has(path.extname(p))) out.push(p);
  }
  return out;
}

const STYLE_CONTRACT = path.join(REPO_ROOT, "01_discovery/output/style-contract.md");

function allowedColours() {
  const tokens = JSON.parse(readFileSync(TOKENS, "utf8"));
  // ONLY the `color` map is authoritative. `notes` names the forbidden v1 purple and must
  // never be treated as an allowlist — that mistake would re-authorise #8B5CF6.
  const allowed = new Set(Object.values(tokens.color).map((v) => String(v).toLowerCase()));
  // The 13 agent-category colours and `sky` live in the style contract, the second authoritative
  // discovery file. apps/cli/src/ui/__tests__/tokens.test.ts accepts hex from either; so do we.
  // The contract is read ONLY from its "Agent category colors" and "ANSI table" sections, so the
  // sentence that names the forbidden purple as forbidden cannot re-authorise it.
  const contract = readFileSync(STYLE_CONTRACT, "utf8");
  const sections = contract.split(/\n## /).filter((sec) => /^(ANSI table|Agent category colors)/.test(sec));
  for (const sec of sections) {
    for (const m of sec.matchAll(/#?([0-9a-fA-F]{6})\b/g)) {
      const hex = "#" + m[1].toLowerCase();
      if (hex !== "#8b5cf6" && hex !== "#0f1117") allowed.add(hex);
    }
  }
  return allowed;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * True when the match sits on a comment line. A comment that NAMES the banned literal in
 * order to explain the ban is documentation, not a violation — and treating it as one is how
 * a scanner trains people to ignore it. Colour literals are NOT given this exemption: a
 * commented-out colour is still a colour somebody will uncomment.
 */
function onCommentLine(text, index) {
  const start = text.lastIndexOf("\n", index) + 1;
  const prefix = text.slice(start, index);
  const trimmed = prefix.trimStart();
  return /^(\/\/|\/\*|\*|#)/.test(trimmed);
}

function scan(files) {
  const allowed = allowedColours();
  const findings = { canned: [], hex: [], emoji: [] };

  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs);
    const text = readFileSync(abs, "utf8");
    const isTest = TEST_RE.test(rel);

    if (!isTest) {
      for (const { id, re } of CANNED_PATTERNS) {
        const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
        for (const m of text.matchAll(g)) {
          if (onCommentLine(text, m.index)) continue;
          findings.canned.push({ file: rel, line: lineOf(text, m.index), rule: id, text: m[0].slice(0, 60) });
        }
      }
    }

    // apps/cli/src/ui/theme.ts is the one file that is ALLOWED to contain hex: it is the token
    // mapping itself, and apps/cli/src/ui/__tests__/tokens.test.ts asserts every hex in it
    // appears in design-tokens.json or the style contract. Everything else must go through it.
    const isTokenMap = rel === "apps/cli/src/ui/theme.ts";
    // Tests may assert a hex that arrives from the read-only catalog (apps/web owns those
    // values); asserting pass-through of data we cannot change is not painting with it.
    for (const m of isTokenMap || isTest ? [] : text.matchAll(HEX_G)) {
      const value = m[0].toLowerCase();
      if (!allowed.has(value)) {
        findings.hex.push({ file: rel, line: lineOf(text, m.index), value: m[0] });
      }
    }

    // The emoji rule is about what the USER SEES, so it covers output surfaces: apps/cli and
    // apps/desktop. packages/trent-core is data and logic; the fleet module, for instance, passes
    // through the catalog's own emoji field from the read-only web app, and the ui layer renders
    // glyphs instead. Flagging the data layer would only force a fake exemption list.
    const isOutputSurface = rel.startsWith("apps/cli/") || rel.startsWith("apps/desktop/");
    if (!isTest && isOutputSurface) {
      for (const m of text.matchAll(EMOJI_G)) {
        if (onCommentLine(text, m.index)) continue;
        findings.emoji.push({
          file: rel,
          line: lineOf(text, m.index),
          codepoint: "U+" + m[0].codePointAt(0).toString(16).toUpperCase(),
        });
      }
    }
  }
  return findings;
}

function report(findings, only) {
  const sections = [
    ["canned", "canned-string literals (anti-pattern #1/#9/#15)", (f) => `${f.file}:${f.line}  [${f.rule}]  ${f.text}`],
    ["hex", "hex colours absent from design-tokens.json (anti-pattern #5)", (f) => `${f.file}:${f.line}  ${f.value}`],
    ["emoji", "emoji in CLI output strings", (f) => `${f.file}:${f.line}  ${f.codepoint}`],
  ];
  let failed = 0;
  const lines = [];
  for (const [key, title, fmt] of sections) {
    if (only && only !== key) continue;
    const hits = findings[key];
    lines.push(`\n## ${title}`);
    if (hits.length === 0) {
      lines.push("  PASS - 0 violations");
      continue;
    }
    failed += hits.length;
    const byFile = new Map();
    for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
    lines.push(`  FAIL - ${hits.length} violations across ${byFile.size} files`);
    for (const h of hits.slice(0, 200)) lines.push("    " + fmt(h));
    if (hits.length > 200) lines.push(`    ... ${hits.length - 200} more`);
  }
  return { text: lines.join("\n"), failed };
}

const args = process.argv.slice(2);
const reportOnly = args.includes("--report-only");
const only = (args.find((a) => a.startsWith("--only=")) ?? "").split("=")[1] || null;

const files = SCAN_ROOTS.flatMap((r) => walk(path.join(REPO_ROOT, r)));
const findings = scan(files);
const { text, failed } = report(findings, only);

process.stdout.write(`repo-scan: ${files.length} files scanned under ${SCAN_ROOTS.join(", ")}\n${text}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# Anti-pattern repo scan\n\n\`\`\`\n${text}\n\`\`\`\n`);
}

if (failed > 0 && !reportOnly) {
  process.stdout.write(`\nrepo-scan FAILED: ${failed} violations. No baseline file exists by design.\n`);
  process.exit(1);
}
process.exit(0);
