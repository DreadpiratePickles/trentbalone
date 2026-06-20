import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  READINESS_CONTROLS,
  REQUIRED_READINESS_CONTROL_SLUGS,
  type ReadinessControlStatus,
} from "../../lib/readiness-controls";

const ROOT = process.cwd();

function fail(message: string): never {
  console.error(`[security-readiness] ${message}`);
  process.exit(1);
}

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

const allowedStatuses = new Set<ReadinessControlStatus>([
  "enforced",
  "partial",
  "external_required",
  "proof_required",
]);

const slugs = READINESS_CONTROLS.map((control) => control.slug);
const required = [...REQUIRED_READINESS_CONTROL_SLUGS];

if (new Set(slugs).size !== slugs.length) {
  fail("READINESS_CONTROLS contains duplicate slugs.");
}

for (const slug of required) {
  if (!slugs.includes(slug)) fail(`Missing readiness control: ${slug}`);
}

for (const control of READINESS_CONTROLS) {
  if (!allowedStatuses.has(control.status)) fail(`${control.slug} has invalid status ${control.status}`);
  if (!control.why.trim()) fail(`${control.slug} is missing why.`);
  if (control.evidence.length === 0) fail(`${control.slug} is missing evidence.`);
  if (control.evidence.some((line) => line.trim().length < 12)) fail(`${control.slug} has weak evidence.`);
  if (control.status !== "enforced" && control.nextAction.trim().length < 20) {
    fail(`${control.slug} needs a specific nextAction.`);
  }
}

const nextConfig = read("next.config.ts");
for (const requiredHeader of [
  "Strict-Transport-Security",
  "Content-Security-Policy",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
]) {
  if (!nextConfig.includes(requiredHeader)) fail(`next.config.ts is missing ${requiredHeader}.`);
}

const ci = read(".github/workflows/ci.yml");
if (!ci.includes("npm run preflight:security")) {
  fail("CI workflow must run npm run preflight:security.");
}

const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
if (!packageJson.scripts?.["security:deps"]?.includes("npm audit --audit-level=high")) {
  fail("package.json must enforce npm audit at high severity or above.");
}
if (!packageJson.scripts?.["security:readiness"]) {
  fail("package.json must expose security:readiness.");
}

console.log(`[security-readiness] ok: ${READINESS_CONTROLS.length} controls checked.`);
