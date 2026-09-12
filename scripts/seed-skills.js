import fs from "node:fs";
import path from "node:path";

const mapPath = path.resolve(process.cwd(), "apps/web/lib/data/skill-agent-map.json");
const skillMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
const skills = skillMap.availableSkills;

const skillsDir = path.resolve(process.cwd(), ".claude/skills");

for (const skill of skills) {
  const dir = path.join(skillsDir, skill);
  fs.mkdirSync(dir, { recursive: true });
  const content = `---
name: ${skill}
description: Operating instructions and best practices for ${skill}
---

# ${skill}

Execute instructions and workflows for ${skill} with strict quality standards, automated checks, and verification before completion.
`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
}

console.log(`Successfully seeded ${skills.length} skills into .claude/skills/`);
