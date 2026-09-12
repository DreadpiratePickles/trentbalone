/**
 * The `sessions` and `mcp` groups.
 *
 * `mcp list` previously printed four hard-coded rows with invented trust scores. It now reads the
 * vetted connector gallery from `@trent/core/mcp` and the servers configured in this profile.
 */

import { SessionManager } from "@trent/core/sessions/index.js";
import { MCP_CONNECTOR_GALLERY, mcpConnectorTemplateById } from "@trent/core/mcp/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { CommandSpec } from "../registry.js";

const MCP_CONFIG_KEY = "mcp_servers";

interface ConfiguredServer {
  name: string;
  url?: string;
  templateId?: string;
}

function readServers(raw: unknown): ConfiguredServer[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is ConfiguredServer => typeof s === "object" && s !== null);
}

export const sessionsSpec: CommandSpec = {
  name: "sessions",
  description: "List, resume and prune conversation sessions",
  subcommands: [
    {
      name: "list",
      description: "List the sessions stored for this profile",
      options: [{ flags: "--limit <n>", description: "Maximum sessions to return" }],
      run(ctx, opts) {
        const all = new SessionManager(ctx.config()).listSessions();
        const limit = typeof opts.limit === "string" ? Number(opts.limit) : undefined;
        const sessions = (Number.isFinite(limit) && limit !== undefined ? all.slice(0, limit) : all).map(
          (s) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            messages: s.messages.length,
            updated_at: s.updated_at,
          }),
        );
        return { data: { count: sessions.length, total: all.length, sessions } };
      },
      render(data, ctx) {
        const d = data as { count: number; sessions: { id: string; title: string; messages: number }[] };
        const lines = [ctx.theme.emphasis(`SESSIONS (${d.count})`)];
        for (const s of d.sessions) {
          lines.push(
            `  ${ctx.theme.value(s.id.padEnd(24, " "))} ${ctx.theme.body(s.title)} ${ctx.theme.meta(`${s.messages} msgs`)}`,
          );
        }
        if (d.sessions.length === 0) lines.push(ctx.theme.meta("  no sessions recorded"));
        return lines;
      },
    },
    {
      name: "resume [sessionId]",
      description: "Resume a session by id, or the most recent one",
      run(ctx, _opts, args) {
        const manager = new SessionManager(ctx.config());
        const requested = args[0];
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "sessions resume", sessionId: requested ?? null } };
        }
        const session = requested ? manager.getSession(requested) : manager.resumeLastSession();
        if (!session) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "sessions.resume",
            message: requested ? "no session with that id" : "no session to resume",
            ...(requested === undefined ? {} : { target: requested }),
          });
        }
        return {
          data: {
            id: session.id,
            title: session.title,
            messages: session.messages.length,
            resumed: true,
          },
        };
      },
      render(data, ctx) {
        const d = data as { id?: string; title?: string; dryRun?: boolean };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would resume")} ${String(d.id ?? "latest")}`];
        return [`  ${ctx.theme.success("resumed")} ${ctx.theme.value(String(d.id))} ${ctx.theme.body(String(d.title))}`];
      },
    },
    {
      name: "prune",
      description: "Delete sessions past the retention bounds",
      options: [
        { flags: "--max-age-days <days>", description: "Delete sessions older than this" },
        { flags: "--max-count <n>", description: "Keep at most this many sessions" },
      ],
      run(ctx, opts) {
        const manager = new SessionManager(ctx.config());
        const bounds: { maxAgeDays?: number; maxCount?: number } = {};
        if (typeof opts.maxAgeDays === "string") bounds.maxAgeDays = Number(opts.maxAgeDays);
        if (typeof opts.maxCount === "string") bounds.maxCount = Number(opts.maxCount);

        if (ctx.dryRun) {
          return {
            data: {
              dryRun: true,
              command: "sessions prune",
              bounds,
              candidates: manager.listSessions().length,
            },
          };
        }
        const result = manager.pruneSessions(bounds);
        return { data: { removed: result.removed, removedCount: result.removed.length, kept: result.kept } };
      },
      render(data, ctx) {
        const d = data as { removedCount?: number; kept?: number; dryRun?: boolean; candidates?: number };
        if (d.dryRun === true) {
          return [`  ${ctx.theme.meta("would consider")} ${String(d.candidates)} session(s)`];
        }
        return [`  ${ctx.theme.success("pruned")} ${String(d.removedCount)}  ${ctx.theme.meta("kept")} ${String(d.kept)}`];
      },
    },
  ],
};

export const mcpSpec: CommandSpec = {
  name: "mcp",
  description: "Manage Model Context Protocol connectors",
  subcommands: [
    {
      name: "list",
      description: "List configured MCP servers and the vetted connector gallery",
      run(ctx) {
        const configured = readServers(ctx.config().get(MCP_CONFIG_KEY));
        return {
          data: {
            configured: configured.map((s) => ({
              name: s.name,
              url: s.url ?? null,
              template: s.templateId ?? null,
            })),
            available: MCP_CONNECTOR_GALLERY.map((t) => ({
              id: t.id,
              name: t.name,
              source: t.source,
              transport: t.transport,
              auth: t.authMode,
            })),
          },
        };
      },
      render(data, ctx) {
        const d = data as {
          configured: { name: string; url: string | null }[];
          available: { id: string; name: string; source: string }[];
        };
        const lines = [ctx.theme.emphasis(`MCP CONNECTORS (${d.configured.length} configured)`)];
        for (const s of d.configured) {
          lines.push(`  ${ctx.theme.success("on ")} ${ctx.theme.value(s.name)} ${ctx.theme.meta(String(s.url ?? ""))}`);
        }
        lines.push(ctx.theme.emphasis(`AVAILABLE (${d.available.length})`));
        for (const t of d.available) {
          lines.push(`  ${ctx.theme.value(t.id.padEnd(22, " "))} ${ctx.theme.body(t.name)} ${ctx.theme.meta(t.source)}`);
        }
        return lines;
      },
    },
    {
      name: "add <server>",
      description: "Add an MCP server, matched against the vetted connector gallery",
      options: [{ flags: "--url <url>", description: "Server endpoint" }],
      run(ctx, opts, args) {
        const name = String(args[0]);
        const url = typeof opts.url === "string" ? opts.url : undefined;
        const template = mcpConnectorTemplateById(name);
        if (ctx.dryRun) {
          return {
            data: { dryRun: true, command: "mcp add", name, url: url ?? null, template: template?.id ?? null },
          };
        }
        const manager = ctx.config();
        const existing = readServers(manager.get(MCP_CONFIG_KEY));
        if (existing.some((s) => s.name === name)) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "mcp.add",
            message: "a server with that name is already configured",
            target: name,
          });
        }
        const entry: ConfiguredServer = {
          name,
          ...(url === undefined ? {} : { url }),
          ...(template === undefined ? {} : { templateId: template.id }),
        };
        manager.set(MCP_CONFIG_KEY, [...existing, entry]);
        return { data: { added: entry, count: existing.length + 1 } };
      },
      render(data, ctx) {
        const d = data as { added?: { name: string }; dryRun?: boolean; name?: string };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would add")} ${String(d.name)}`];
        return [`  ${ctx.theme.success("added")} ${ctx.theme.value(String(d.added?.name))}`];
      },
    },
    {
      name: "remove <server>",
      description: "Remove a configured MCP server",
      run(ctx, _opts, args) {
        const name = String(args[0]);
        if (ctx.dryRun) return { data: { dryRun: true, command: "mcp remove", name } };
        const manager = ctx.config();
        const existing = readServers(manager.get(MCP_CONFIG_KEY));
        const remaining = existing.filter((s) => s.name !== name);
        if (remaining.length === existing.length) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "mcp.remove",
            message: "no server with that name is configured",
            target: name,
          });
        }
        manager.set(MCP_CONFIG_KEY, remaining);
        return { data: { removed: name, count: remaining.length } };
      },
      render(data, ctx) {
        const d = data as { removed: string };
        return [`  ${ctx.theme.success("removed")} ${ctx.theme.value(d.removed)}`];
      },
    },
  ],
};
