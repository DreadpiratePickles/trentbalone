// Regenerates packages/trent-core/src/config/schema-split.snapshot.json from the schema in the CURRENT directory tree.
import { readFileSync, writeFileSync } from "node:fs";
const { TrentConfigSchema } = await import(process.cwd() + "/packages/trent-core/src/config/schema.ts");
const { DEFAULT_CONFIG } = await import(process.cwd() + "/packages/trent-core/src/config/defaults.ts");
const dir = process.cwd() + "/packages/trent-core/src/config/";
const input = JSON.parse(readFileSync(dir + "schema-split.input.json", "utf8"));
const out = { defaults: TrentConfigSchema.parse(DEFAULT_CONFIG), full: TrentConfigSchema.parse(input) };
writeFileSync(dir + "schema-split.snapshot.json", JSON.stringify(out, null, 2) + "\n");
console.log("snapshot keys:", Object.keys(out.full).length);
