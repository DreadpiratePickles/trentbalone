/**
 * The `skills` group. Browse and search read the built-in catalog; install, view, list and remove
 * read and write the profile's one skill store — the same store, in the same canonical form, that
 * the `skills` toolset (`skills_list`, `skill_view`, `skill_manage`) uses. A skill the agent
 * authored is listed here, and a skill installed here is editable there.
 */

import { SkillsHub, findSkillRecord } from "@trent/core/skills/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { CommandSpec } from "../registry.js";

export const skillsSpec: CommandSpec = {
  name: "skills",
  description: "Browse, search, install, view and remove skills",
  subcommands: [
    {
      name: "browse",
      description: "Browse the skills catalog",
      run(ctx) {
        const catalog = new SkillsHub(ctx.config()).browse();
        return { data: { count: catalog.length, skills: catalog } };
      },
      render: renderSkillCatalog,
    },
    {
      name: "search <term>",
      description: "Search the skills catalog by keyword",
      run(ctx, _opts, args) {
        const term = String(args[0]);
        const matches = new SkillsHub(ctx.config()).search(term);
        return { data: { term, count: matches.length, skills: matches } };
      },
      render: renderSkillCatalog,
    },
    {
      name: "install <slug>",
      description: "Install a skill after its pre-install security scan",
      run(ctx, _opts, args) {
        const slug = String(args[0]);
        if (ctx.dryRun) return { data: { dryRun: true, command: "skills install", slug } };
        const loaded = new SkillsHub(ctx.config()).install(slug);
        return {
          data: {
            slug: loaded.slug,
            name: loaded.name,
            slashCommand: loaded.slashCommand,
            installed: true,
          },
        };
      },
      render(data, ctx) {
        const d = data as { slug: string; slashCommand?: string; dryRun?: boolean };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would install")} ${d.slug}`];
        return [
          `  ${ctx.theme.success("installed")} ${ctx.theme.value(d.slug)} ${ctx.theme.meta(String(d.slashCommand))}`,
        ];
      },
    },
    {
      name: "view <slug>",
      description: "Print one installed skill: its metadata and its full instructions",
      run(ctx, _opts, args) {
        const slug = String(args[0]);
        // A read migrates the legacy flat form, so even this one is withheld under --dry-run.
        if (ctx.dryRun) return { data: { dryRun: true, command: "skills view", slug } };
        const record = findSkillRecord(ctx.config().getSkillsDir(), slug);
        if (record === null) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "skills.view",
            message: "skill is not installed in this profile",
            target: slug,
          });
        }
        return {
          data: {
            slug: record.name,
            name: record.title,
            description: record.description,
            category: record.category,
            trust: record.trust,
            version: record.version,
            author: record.author,
            tags: record.tags,
            file: record.file,
            instructions: record.instructions,
          },
        };
      },
      render(data, ctx) {
        const d = data as {
          slug: string;
          name: string;
          description: string;
          category: string;
          trust: string;
          version: string;
          instructions: string;
        };
        return [
          ctx.theme.emphasis(`${d.slug} ${d.name}`),
          `  ${ctx.theme.meta("category")} ${ctx.theme.value(d.category)}  ${ctx.theme.meta("trust")} ${ctx.theme.value(d.trust)}  ${ctx.theme.meta("version")} ${ctx.theme.value(d.version)}`,
          `  ${ctx.theme.body(d.description)}`,
          "",
          ...d.instructions.split("\n").map((line) => `  ${ctx.theme.body(line)}`),
        ];
      },
    },
    {
      name: "remove <slug>",
      description: "Remove an installed skill",
      run(ctx, _opts, args) {
        const slug = String(args[0]);
        if (ctx.dryRun) return { data: { dryRun: true, command: "skills remove", slug } };
        const removed = new SkillsHub(ctx.config()).remove(slug);
        if (!removed) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "skills.remove",
            message: "skill is not installed in this profile",
            target: slug,
          });
        }
        return { data: { slug, removed } };
      },
      render(data, ctx) {
        const d = data as { slug: string };
        return [`  ${ctx.theme.success("removed")} ${ctx.theme.value(d.slug)}`];
      },
    },
    {
      name: "list",
      description: "List the skills installed in this profile",
      run(ctx) {
        const installed = new SkillsHub(ctx.config()).listInstalled();
        return { data: { count: installed.length, skills: installed } };
      },
      render: renderSkillCatalog,
    },
  ],
};

function renderSkillCatalog(
  data: Record<string, unknown> | unknown[],
  ctx: { theme: { emphasis: (s: string) => string; value: (s: string) => string; body: (s: string) => string } },
): string[] {
  const d = data as { count: number; skills: { slug: string; description: string }[] };
  const lines = [ctx.theme.emphasis(`SKILLS (${d.count})`)];
  for (const s of d.skills) {
    lines.push(`  ${ctx.theme.value(s.slug.padEnd(26, " "))} ${ctx.theme.body(s.description)}`);
  }
  return lines;
}
