import { Sandbox } from "e2b";

const template = process.env.E2B_TEMPLATE ?? "base";
const apiKey = process.env.E2B_API_KEY;
if (!apiKey) { console.log("NO E2B_API_KEY"); process.exit(1); }

console.log(`creating sandbox (template=${template})...`);
const t0 = Date.now();
const sb = await Sandbox.create(template, { apiKey, timeoutMs: 120_000, secure: false });
console.log(`sandbox ${sb.sandboxId} up in ${Date.now() - t0}ms`);

for (const cmd of ["node --version", "npm --version", "git --version", "python3 --version"]) {
  try {
    const r = await sb.commands.run(cmd, { timeoutMs: 20_000 });
    console.log(`  ${cmd} -> ${(r.stdout || r.stderr || "").trim()} (exit ${r.exitCode})`);
  } catch (e) {
    console.log(`  ${cmd} -> ERROR ${String(e.message || e).slice(0, 80)}`);
  }
}

// Prove isolation + preview host
try {
  const host = sb.getHost(3000);
  console.log(`  preview host for :3000 -> https://${host}`);
} catch (e) { console.log("  getHost error:", String(e.message || e).slice(0, 80)); }

// Quick npm sanity: can it install a tiny package?
try {
  const r = await sb.commands.run("cd /tmp && npm init -y >/dev/null 2>&1 && npm i left-pad >/dev/null 2>&1 && node -e \"console.log(require('left-pad')('ok',5))\"", { timeoutMs: 60_000 });
  console.log(`  npm install smoke -> '${(r.stdout || r.stderr || "").trim()}' (exit ${r.exitCode})`);
} catch (e) { console.log("  npm smoke ERROR:", String(e.message || e).slice(0, 100)); }

await sb.kill();
console.log("sandbox killed. PREFLIGHT DONE.");
