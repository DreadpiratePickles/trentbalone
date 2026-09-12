import fs from "node:fs";
import path from "node:path";

export interface SkillMetadata {
  slug: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  slashCommand: string;
  author: string;
  file: string;
}

export interface LoadedSkill extends SkillMetadata {
  instructions: string;
}

export class SkillLoader {
  private skillsDir: string;
  private cache: Map<string, SkillMetadata> = new Map();

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  public listMetadata(): SkillMetadata[] {
    if (!fs.existsSync(this.skillsDir)) return [];
    const files = fs.readdirSync(this.skillsDir);
    const result: SkillMetadata[] = [];

    for (const file of files) {
      if (file.endsWith(".md") || file.endsWith(".json")) {
        const slug = file.replace(/\.(md|json)$/, "");
        const meta = this.getMetadata(slug);
        if (meta) {
          result.push(meta);
        }
      }
    }

    return result;
  }

  public getMetadata(slug: string): SkillMetadata | null {
    if (this.cache.has(slug)) {
      return this.cache.get(slug)!;
    }

    const mdPath = path.join(this.skillsDir, `${slug}.md`);
    const jsonPath = path.join(this.skillsDir, `${slug}.json`);

    if (fs.existsSync(jsonPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        const meta: SkillMetadata = {
          slug,
          name: raw.name || slug,
          description: raw.description || "",
          version: raw.version || "1.0.0",
          tags: raw.tags || [],
          slashCommand: `/${slug}`,
          author: raw.author || "trent",
          file: jsonPath,
        };
        this.cache.set(slug, meta);
        return meta;
      } catch {
        return null;
      }
    }

    if (fs.existsSync(mdPath)) {
      try {
        const content = fs.readFileSync(mdPath, "utf8");
        // Parse simple markdown header
        const lines = content.split("\n");
        let name = slug;
        let description = "";

        for (const line of lines) {
          if (line.startsWith("# ")) {
            name = line.replace("# ", "").trim();
          } else if (line.startsWith("> ") && !description) {
            description = line.replace("> ", "").trim();
          }
        }

        const meta: SkillMetadata = {
          slug,
          name,
          description: description || `Skill for ${name}`,
          version: "1.0.0",
          tags: ["general"],
          slashCommand: `/${slug}`,
          author: "community",
          file: mdPath,
        };
        this.cache.set(slug, meta);
        return meta;
      } catch {
        return null;
      }
    }

    return null;
  }

  public loadFull(slug: string): LoadedSkill {
    const meta = this.getMetadata(slug);
    if (!meta) {
      throw new Error(`Skill "${slug}" not found in ${this.skillsDir}`);
    }

    let instructions = "";
    if (meta.file.endsWith(".json")) {
      const parsed = JSON.parse(fs.readFileSync(meta.file, "utf8"));
      instructions = parsed.instructions || parsed.content || "";
    } else {
      instructions = fs.readFileSync(meta.file, "utf8");
    }

    return {
      ...meta,
      instructions,
    };
  }
}
