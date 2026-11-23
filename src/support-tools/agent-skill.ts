import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentSkillTarget = "claude" | "codex" | "google" | "all";

export interface InstallSkillOptions {
  target: AgentSkillTarget;
  global?: boolean;
  dir?: string;
  force?: boolean;
  homeDir?: string;
}

const SKILL_NAME = "hls-dash-live-sim";

export function bundledSkillPath(): string {
  const candidates = [
    path.resolve(__dirname, "assets/skill/SKILL.md"),
    path.resolve(__dirname, "../../assets/skill/SKILL.md"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Bundled SKILL.md asset could not be located; run `npm run build` first");
}

export function readBundledSkill(): string {
  return fs.readFileSync(bundledSkillPath(), "utf8");
}

export function resolveSkillTargets(options: InstallSkillOptions): string[] {
  if (options.global && options.dir) {
    throw new Error("Choose either --global or --dir, not both");
  }
  const base = path.resolve(options.global ? options.homeDir ?? os.homedir() : options.dir ?? process.cwd());
  const relPaths: string[] = [];
  const includeClaude = options.target === "claude" || options.target === "all";
  const includeCodex = options.target === "codex" || options.target === "all";
  const includeGoogle = options.target === "google" || options.target === "all";

  if (options.global) {
    if (includeClaude) relPaths.push(path.join(".claude", "skills", SKILL_NAME, "SKILL.md"));
    if (includeCodex) relPaths.push(path.join(".codex", "skills", SKILL_NAME, "SKILL.md"));
    if (includeGoogle) {
      relPaths.push(path.join(".gemini", "skills", SKILL_NAME, "SKILL.md"));
      relPaths.push(path.join(".gemini", "config", "skills", SKILL_NAME, "SKILL.md"));
    }
  } else {
    if (includeClaude) relPaths.push(path.join(".claude", "skills", SKILL_NAME, "SKILL.md"));
    if (includeCodex || includeGoogle) {
      // Both OpenAI Codex and Google Antigravity load project skills from .agents/skills/.
      relPaths.push(path.join(".agents", "skills", SKILL_NAME, "SKILL.md"));
    }
    if (includeGoogle) {
      // Standalone Gemini CLI also discovers workspace skills in .gemini/skills/.
      relPaths.push(path.join(".gemini", "skills", SKILL_NAME, "SKILL.md"));
    }
  }

  return [...new Set(relPaths.map(rel => path.join(base, rel)))];
}

export function installAgentSkill(options: InstallSkillOptions): { written: string[] } {
  const content = readBundledSkill();
  const destinations = resolveSkillTargets(options);
  if (!options.force) {
    const existing = destinations.filter(dest => fs.existsSync(dest));
    if (existing.length > 0) {
      throw new Error(
        `Refusing to overwrite existing skill file(s): ${existing.join(", ")} (pass --force to replace)`,
      );
    }
  }
  for (const dest of destinations) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (options.force) {
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o644 });
      fs.renameSync(tmp, dest);
    } else {
      const fd = fs.openSync(dest, "wx", 0o644);
      try {
        fs.writeFileSync(fd, content, "utf8");
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return { written: destinations };
}
