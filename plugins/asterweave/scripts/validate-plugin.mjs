#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

function walk(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}

function parseFrontmatter(content, file) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) values[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function parseJson(file, errors) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${relative(process.cwd(), file)}: invalid JSON (${error.message})`);
    return null;
  }
}

export function validatePlugin(rootInput) {
  const root = resolve(rootInput);
  const errors = [];
  const warnings = [];
  const required = [
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "hooks/hooks.json",
    "agents",
    "skills",
    "scripts",
    "references",
  ];
  for (const entry of required) if (!existsSync(join(root, entry))) errors.push(`Missing ${entry}`);

  const manifest = parseJson(join(root, ".claude-plugin", "plugin.json"), errors);
  if (manifest) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name || "")) errors.push("plugin.json: name must be kebab-case");
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version || "")) errors.push("plugin.json: version must be semver");
    const rendered = JSON.stringify(manifest);
    if (/gh[opurs]_[A-Za-z0-9]{20,}/.test(rendered)) errors.push("plugin.json appears to contain a GitHub token");
  }

  for (const jsonFile of walk(root).filter((file) => file.endsWith(".json"))) parseJson(jsonFile, errors);

  const skillNames = new Set();
  const skillRoot = join(root, "skills");
  if (existsSync(skillRoot)) {
    for (const directory of readdirSync(skillRoot)) {
      const skillFile = join(skillRoot, directory, "SKILL.md");
      if (!existsSync(skillFile)) {
        errors.push(`skills/${directory}: missing SKILL.md`);
        continue;
      }
      const content = readFileSync(skillFile, "utf8");
      try {
        const frontmatter = parseFrontmatter(content, relative(root, skillFile));
        if (!frontmatter.name) errors.push(`${relative(root, skillFile)}: missing name`);
        if (!frontmatter.description) errors.push(`${relative(root, skillFile)}: missing description`);
        if (skillNames.has(frontmatter.name)) errors.push(`Duplicate skill name: ${frontmatter.name}`);
        skillNames.add(frontmatter.name);
      } catch (error) {
        errors.push(error.message);
      }
      if (/\b(?:TODO|TBD|YOUR_GITHUB_PAT)\b/.test(content)) errors.push(`${relative(root, skillFile)}: unresolved placeholder`);
    }
  }

  const agentNames = new Set();
  const agentRoot = join(root, "agents");
  if (existsSync(agentRoot)) {
    for (const fileName of readdirSync(agentRoot).filter((name) => name.endsWith(".md"))) {
      const file = join(agentRoot, fileName);
      const content = readFileSync(file, "utf8");
      try {
        const frontmatter = parseFrontmatter(content, relative(root, file));
        for (const field of ["name", "description", "model", "tools"]) {
          if (!frontmatter[field]) errors.push(`${relative(root, file)}: missing ${field}`);
        }
        if (agentNames.has(frontmatter.name)) errors.push(`Duplicate agent name: ${frontmatter.name}`);
        agentNames.add(frontmatter.name);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }

  const hooks = parseJson(join(root, "hooks", "hooks.json"), errors);
  const hookText = JSON.stringify(hooks || {});
  for (const match of hookText.matchAll(/scripts\/([A-Za-z0-9._-]+)/g)) {
    if (!existsSync(join(root, "scripts", match[1]))) errors.push(`Hook references missing script: scripts/${match[1]}`);
  }

  const allText = walk(root)
    .filter((file) => statSync(file).size < 1_000_000)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  if (/gh[opurs]_[A-Za-z0-9]{20,}/.test(allText)) errors.push("Plugin appears to contain a GitHub token");
  if (!/graph-state\.mjs/.test(allText)) warnings.push("No graph-state usage found");

  for (const markdown of walk(root).filter((file) => file.endsWith(".md"))) {
    const content = readFileSync(markdown, "utf8");
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
      if (!existsSync(resolve(dirname(markdown), target))) {
        errors.push(`${relative(root, markdown)}: broken local link ${match[1]}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, counts: { skills: skillNames.size, agents: agentNames.size } };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2] || resolve(dirname(new URL(import.meta.url).pathname), "..");
  const result = validatePlugin(root);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}
