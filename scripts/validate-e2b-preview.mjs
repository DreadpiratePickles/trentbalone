// Validates the E2B preview fix end-to-end in a real microVM:
//   1. spin a sandbox  2. seed the production starter scaffold (with allowedHosts:true)
//   3. npm install      4. start the vite dev server (0.0.0.0:3000)
//   5. curl the public *.e2b.app preview host  -> EXPECT HTTP 200 (was 403 before the fix)
import { Sandbox } from "e2b";

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const PKG = JSON.stringify({
  name: "trent-app", version: "0.1.0", private: true, type: "module",
  scripts: { dev: "vite --host 0.0.0.0 --port 3000", build: "tsc && vite build" },
  dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
  devDependencies: { "@vitejs/plugin-react": "^4.3.1", typescript: "^5.5.3", vite: "^5.4.1" },
}, null, 2);

const VITE = `import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
export default defineConfig({
  plugins: [react()],
  // The exact fix under test: allowedHosts lets Vite serve the *.e2b.app preview host.
  server: { port: 3000, host: true, allowedHosts: true },
})`;

const HTML = `<!doctype html><html><head><title>App</title></head>
<body><div id="root">trent-e2b-ok</div><script type="module" src="/src/main.tsx"></script></body></html>`;

const MAIN = `import React from "react"
import { createRoot } from "react-dom/client"
createRoot(document.getElementById("root")).render(React.createElement("h1", null, "trent-e2b-ok"))`;

const sb = await Sandbox.create({ timeoutMs: 5 * 60 * 1000 });
try {
  log("sandbox up:", sb.sandboxId);
  const dir = "/home/user";
  await sb.files.write(`${dir}/package.json`, PKG);
  await sb.files.write(`${dir}/vite.config.ts`, VITE);
  await sb.files.write(`${dir}/index.html`, HTML);
  await sb.files.write(`${dir}/src/main.tsx`, MAIN);
  log("scaffold written");

  log("npm install --legacy-peer-deps ...");
  const inst = await sb.commands.run("cd /home/user && npm install --legacy-peer-deps", { timeoutMs: 4 * 60 * 1000 });
  log("install exit:", inst.exitCode);
  if (inst.exitCode !== 0) { console.log(inst.stderr.slice(-800)); throw new Error("install failed"); }

  log("starting dev server (background) ...");
  sb.commands.run("cd /home/user && npm run dev > /tmp/dev.log 2>&1", { background: true });

  const host = `https://${sb.getHost(3000)}`;
  log("preview host:", host);

  // poll the preview host until it answers
  let status = 0, body = "";
  for (let i = 0; i < 30; i++) {
    const r = await sb.commands.run(`curl -s -o /tmp/body -w '%{http_code}' ${host} || true`);
    status = parseInt(r.stdout.trim(), 10) || 0;
    if (status === 200) { body = (await sb.commands.run("cat /tmp/body || true")).stdout; break; }
    if (status === 403) { body = (await sb.commands.run("cat /tmp/body || true")).stdout; break; }
    await new Promise((res) => setTimeout(res, 2000));
  }

  log("HTTP status:", status);
  log("body[0:120]:", body.slice(0, 120).replace(/\n/g, " "));
  if (status === 200) {
    log("✅ PASS — preview host serves 200 (allowedHosts fix works; 403 is gone)");
  } else if (status === 403) {
    log("❌ FAIL — still 403; allowedHosts not taking effect");
    console.log("dev.log tail:", (await sb.commands.run("tail -20 /tmp/dev.log || true")).stdout);
  } else {
    log("⚠️ inconclusive — status", status);
    console.log("dev.log tail:", (await sb.commands.run("tail -20 /tmp/dev.log || true")).stdout);
  }
} finally {
  await sb.kill();
  log("sandbox killed (clean teardown)");
}
