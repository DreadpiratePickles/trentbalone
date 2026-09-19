#!/usr/bin/env node
/**
 * pages-release-gate.mjs — decide whether GitHub Pages may serve the installers yet.
 *
 *   node scripts/ci/pages-release-gate.mjs <releases.json>     # `gh api repos/<repo>/releases`
 *
 * Why this exists. `scripts/install.sh` pins no version and no checksum: it resolves
 * `https://github.com/<repo>/releases/latest` at run time, then verifies a signature over the
 * `SHA256SUMS` of whatever that resolves to (`scripts/installer/THREAT-MODEL.md`). `pages.yml`
 * triggers on a push to `main` that touches the installers as well as on `release: published`, so
 * without this gate a merge to `main` starts advertising `curl -fsSL .../install.sh | bash` while
 * `releases/latest` is still a 404 — the installer then fails at `resolve-version` and installs
 * nothing, which is the correct failure of an incorrect deploy. The site waits for a release.
 *
 * `releases/latest` ignores drafts AND prereleases, so only a published, non-draft,
 * non-prerelease release makes the advertised command work. A human can still deploy early —
 * to configure the custom domain or let GitHub provision a certificate — with
 * `workflow_dispatch` and `allow_without_release: true`, which is recorded in the reason.
 *
 * Exit codes: 0 with `serve=true|false` on `$GITHUB_OUTPUT` (the decision is an output, never a
 * failure), 2 if the release list cannot be read (fail loudly rather than no-op by accident).
 */
import { appendFileSync, readFileSync } from "node:fs";

/**
 * @param {{eventName?: string, releases: Array<{tag_name?: string, draft?: boolean, prerelease?: boolean}>, allowWithoutRelease?: boolean}} input
 * @returns {{serve: boolean, reason: string}}
 */
export function decideServe({ eventName, releases, allowWithoutRelease = false }) {
  const published = releases.filter((r) => r && r.draft !== true && r.prerelease !== true);
  if (published.length > 0) {
    const tags = published.map((r) => r.tag_name).filter(Boolean);
    return {
      serve: true,
      reason: `${published.length} published release(s) exist (${tags.slice(0, 3).join(", ")}); releases/latest resolves`,
    };
  }
  if (allowWithoutRelease && eventName === "workflow_dispatch") {
    return {
      serve: true,
      reason: "no published release, but this dispatch set allow_without_release=true (domain or certificate setup)",
    };
  }
  const skipped = releases.length - published.length;
  const detail =
    skipped > 0
      ? `${skipped} release(s) exist but every one is a draft or a prerelease, which releases/latest ignores`
      : "the repository has no releases";
  return {
    serve: false,
    reason: `refusing to serve install.sh: ${detail}, so releases/latest would 404 and the installer would fail at resolve-version. Publish a release, or dispatch Pages with allow_without_release=true.`,
  };
}

function main(argv) {
  const file = argv[0];
  if (!file) {
    console.error("usage: pages-release-gate.mjs <releases.json>");
    return 2;
  }
  let releases;
  try {
    releases = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`pages-release-gate: cannot read the release list from ${file}: ${err.message}`);
    return 2;
  }
  if (!Array.isArray(releases)) {
    console.error(`pages-release-gate: ${file} is not the JSON array that \`gh api repos/<repo>/releases\` returns`);
    return 2;
  }
  const decision = decideServe({
    eventName: process.env.GITHUB_EVENT_NAME,
    releases,
    allowWithoutRelease: process.env.TRENT_PAGES_ALLOW_WITHOUT_RELEASE === "true",
  });
  console.log(`pages-release-gate: serve=${decision.serve} — ${decision.reason}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `serve=${decision.serve}\nreason=${decision.reason.replace(/\n/g, " ")}\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
