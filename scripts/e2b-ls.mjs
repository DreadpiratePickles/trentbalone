import { Sandbox } from "e2b";
const sb = await Sandbox.create(process.env.E2B_TEMPLATE ?? "base", { apiKey: process.env.E2B_API_KEY, timeoutMs: 60000, secure:false });
const r = await sb.commands.run("ls -la /home/user", { timeoutMs: 15000 });
console.log("workdir /home/user:\n" + (r.stdout || r.stderr));
await sb.kill();
