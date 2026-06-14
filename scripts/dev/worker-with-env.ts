/** Dev-only: load an env file then boot the BullMQ worker (worker.ts has import-time side effects). */
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";

const file = process.argv[2] ?? "trent.env.local";
loadAllowedEvalEnvFile(file, () => true);
if (process.env.DATABASE_URL && !process.env.DIRECT_URL) process.env.DIRECT_URL = process.env.DATABASE_URL;

void import("@/lib/worker");
