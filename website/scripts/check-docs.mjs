#!/usr/bin/env node
// Fails if a plugin skill/agent has no corresponding documentation page, or if a
// documented command/agent page no longer corresponds to anything in the plugin source.
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const websiteDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(websiteDir);
const pluginDir = path.join(repoRoot, "plugins", "asterweave");

function names(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function mdNames(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "overview.md")
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

const skills = names(path.join(pluginDir, "skills"));
const agents = readdirSync(path.join(pluginDir, "agents"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""))
  .sort();

const documentedCommands = mdNames(path.join(websiteDir, "docs", "commands"));
const documentedAgents = mdNames(path.join(websiteDir, "docs", "agents"));

let failed = false;

function diff(label, actual, documented) {
  const missing = actual.filter((n) => !documented.includes(n));
  const stale = documented.filter((n) => !actual.includes(n));
  if (missing.length) {
    failed = true;
    console.error(`[check-docs] ${label} missing documentation: ${missing.join(", ")}`);
  }
  if (stale.length) {
    failed = true;
    console.error(`[check-docs] ${label} documented but no longer exist in the plugin: ${stale.join(", ")}`);
  }
}

diff("skills", skills, documentedCommands);
diff("agents", agents, documentedAgents);

if (failed) {
  console.error("[check-docs] Documentation drift detected. See errors above.");
  process.exit(1);
}

console.log(`[check-docs] OK — ${skills.length} skills and ${agents.length} agents all documented.`);
