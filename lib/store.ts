import { memStore } from "@/lib/mem-store";
import { prismaStore } from "@/lib/prisma-store";

/**
 * The active store. Uses Prisma-backed persistence when DATABASE_URL is set,
 * otherwise falls back to the in-memory store (local dev / tests).
 *
 * Switch is evaluated once at process startup — changing DATABASE_URL requires
 * restarting `npm run dev` and the worker. See docs/RUN.md § Data persistence.
 */
export const store: typeof memStore = process.env.DATABASE_URL
  ? (prismaStore as unknown as typeof memStore)
  : memStore;
