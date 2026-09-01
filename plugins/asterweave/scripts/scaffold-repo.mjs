#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { detectStack } from "./detect-stack.mjs";

const SCAFFOLD_VERSION = 1;
const DEFAULT_PLUGIN_VERSION = "0.2.1";
const MANIFEST_PATH = ".claude/asterweave-scaffold.json";
const TRANSIENT_PREFIX = ".claude/asterweave/";
const MAX_ARTIFACTS = 60;
const MAX_FILE_BYTES = 128_000;
const MAX_TOTAL_BYTES = 1_000_000;
const ALLOWED_STAGES = new Set([
  "analyze",
  "challenge",
  "plan",
  "implement",
  "test",
  "verify",
  "review",
  "submit-pr",
  "monitor-pipeline",
  "resolve-review-comments",
  "update-work-item",
]);
const ALLOWED_KINDS = new Set(["instructions", "rule", "skill", "agent", "reference", "adapter"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vs",
  ".vscode",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "target",
  "vendor",
]);
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.|$)|secrets?(?:\.|\/|$)|credentials?(?:\.|\/|$)|id_(?:rsa|ed25519)(?:\.|$)|[^/]+\.(?:pem|p12|pfx|key))|(?:^|\/)\.aws(?:\/|$)/i;
const SECRET_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opurs]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];
const DESTRUCTIVE_COMMAND = /(?:^|\s)(?:sudo\s+)?(?:rm\s+-rf|git\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+--force)|terraform\s+(?:apply|destroy)|kubectl\s+delete|docker\s+system\s+prune|(?:npm|pnpm|yarn)\s+publish|dotnet\s+nuget\s+push)(?:\s|$)/i;
const UNSAFE_SHELL_SYNTAX = /(?:[;`|<>]|\$\(|\|\|)/;
const EXTERNAL_SIDE_EFFECT_COMMAND = /(?:^|\s)(?:curl|wget|ssh|scp|rsync|az|aws|gcloud|gh\s+(?:api|release)|helm\s+(?:install|upgrade|uninstall)|kubectl\s+(?:apply|patch|set)|terraform\s+(?:plan|apply|destroy)|(?:npm|pnpm|yarn)\s+publish)(?:\s|$)/i;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error.message})`);
  }
}

function parseFrontmatter(content, file) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) values[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function normalizeRelativePath(input) {
  if (typeof input !== "string" || !input || input.includes("\0") || isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
    return null;
  }
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return normalized;
}

function resolveInside(root, input) {
  const normalized = normalizeRelativePath(input);
  if (!normalized) throw new Error(`Unsafe repository-relative path: ${String(input)}`);
  const target = resolve(root, ...normalized.split("/"));
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`Path escapes repository root: ${input}`);
  return { normalized, target };
}

function hasSymlinkAncestor(root, target) {
  let current = target;
  while (current !== root) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
    const parent = dirname(current);
    if (parent === current || !parent.startsWith(root)) break;
    current = parent;
  }
  return false;
}

function allowedTarget(path, kind) {
  if (path === "CLAUDE.md") return kind === "instructions";
  if (path === ".claude/asterweave.json") return kind === "adapter";
  if (/^\.claude\/rules\/[a-z0-9][a-z0-9/_-]*\.md$/.test(path)) return kind === "rule";
  if (/^\.claude\/agents\/[a-z0-9][a-z0-9/_-]*\.md$/.test(path)) return kind === "agent";
  if (/^\.claude\/references\/[a-z0-9][a-z0-9/_-]*\.md$/.test(path)) return kind === "reference";
  const skillEntry = path.match(/^\.claude\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/);
  if (skillEntry) return kind === "skill";
  const skillResource = path.match(/^\.claude\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(references|scripts)\/[a-z0-9][a-z0-9/_.-]*$/);
  if (skillResource) {
    const extension = extname(path).toLowerCase();
    return kind === "reference" && [".md", ".json", ".yaml", ".yml", ".sh", ".ps1", ".js", ".mjs", ".ts", ".py"].includes(extension);
  }
  return false;
}

function walk(root, { maxDepth = 5, maxEntries = 25_000 } = {}) {
  const files = [];
  const queue = [{ path: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < maxEntries) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= maxEntries) break;
      const path = join(current.path, entry.name);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !EXCLUDED_DIRECTORIES.has(entry.name) && !rel.startsWith(TRANSIENT_PREFIX)) {
          queue.push({ path, depth: current.depth + 1 });
        }
      } else if (entry.isFile() && !SENSITIVE_PATH.test(rel)) {
        files.push(path);
      }
    }
  }
  return { files, truncated: visited >= maxEntries };
}

function gitInfo(root) {
  function git(args) {
    try {
      return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 1_000_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      return null;
    }
  }
  const topLevel = git(["rev-parse", "--show-toplevel"]);
  if (!topLevel) return { isRepository: false };
  const status = git(["status", "--short"]);
  return {
    isRepository: true,
    topLevel,
    branch: git(["branch", "--show-current"]),
    head: git(["rev-parse", "HEAD"]),
    dirtyPaths: status ? status.split(/\r?\n/).slice(0, 200).map((line) => line.slice(3)) : [],
    statusTruncated: Boolean(status && status.split(/\r?\n/).length > 200),
  };
}

function artifactMetadata(root, file) {
  const content = readFileSync(file, "utf8");
  return {
    path: relative(root, file).replaceAll("\\", "/"),
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    lines: content.split(/\r?\n/).length,
  };
}

function evidenceCandidates(root, files) {
  const patterns = [
    /(?:^|\/)(?:README|CONTRIBUTING|ARCHITECTURE|SECURITY)(?:\.[^/]+)?$/i,
    /(?:^|\/)(?:package\.json|composer\.json|pyproject\.toml|pubspec\.yaml|Cargo\.toml|go\.mod)$/,
    /(?:^|\/)[^/]+\.(?:sln|slnx|csproj|fsproj)$/i,
    /(?:^|\/)(?:Dockerfile|docker-compose[^/]*\.ya?ml)$/i,
    /(?:^|\/)(?:\.github\/workflows|\.gitlab-ci|azure-pipelines|\.circleci)(?:\/|\.|$)/i,
    /(?:^|\/)(?:test|tests|spec|specs|e2e|integration)(?:\/|$)/i,
    /(?:^|\/)(?:angular\.json|next\.config\.[^/]+|vite\.config\.[^/]+|manage\.py|artisan)$/i,
  ];
  return files
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .filter((file) => patterns.some((pattern) => pattern.test(file)))
    .sort()
    .slice(0, 300);
}

export function inventoryRepository(rootInput = process.cwd()) {
  const root = resolve(rootInput);
  const { files, truncated } = walk(root);
  const configurationFiles = files.filter((file) => {
    const path = relative(root, file).replaceAll("\\", "/");
    return path === "CLAUDE.md" || path.startsWith(".claude/");
  });
  let managed = null;
  if (existsSync(join(root, MANIFEST_PATH))) {
    try {
      const manifest = readJson(join(root, MANIFEST_PATH));
      managed = {
        schemaVersion: manifest.schemaVersion,
        pluginVersion: manifest.pluginVersion,
        blueprintDigest: manifest.blueprintDigest,
        artifacts: Array.isArray(manifest.artifacts) ? manifest.artifacts.map(({ path, sha256: hash, stale }) => ({ path, sha256: hash, stale: Boolean(stale) })) : [],
      };
    } catch (error) {
      managed = { error: error.message };
    }
  }
  return {
    schemaVersion: SCAFFOLD_VERSION,
    root,
    git: gitInfo(root),
    stack: detectStack(root),
    existingConfiguration: configurationFiles.map((file) => artifactMetadata(root, file)).sort((a, b) => a.path.localeCompare(b.path)),
    managedScaffold: managed,
    evidenceCandidates: evidenceCandidates(root, files),
    exclusions: ["dependency/build output", "transient .claude/asterweave state", "secret-like paths", "symlinks"],
    warnings: [
      ...(truncated ? ["Repository inventory reached its safety limit; inspect deeper modules explicitly."] : []),
      ...(configurationFiles.length ? ["Existing repository instructions exist and must be merged, never replaced without exact-hash approval."] : []),
      ...(managed?.error ? ["The existing scaffold manifest is invalid; stop before refresh or apply."] : []),
    ],
  };
}

function collectExistingDefinitions(root, category, ignoredTargets) {
  const base = join(root, ".claude", category);
  const names = new Map();
  if (!existsSync(base)) return names;
  const { files } = walk(base, { maxDepth: 6, maxEntries: 5_000 });
  for (const file of files.filter((candidate) => candidate.endsWith(".md"))) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (ignoredTargets.has(rel)) continue;
    try {
      const frontmatter = parseFrontmatter(readFileSync(file, "utf8"), rel);
      if (frontmatter.name) names.set(frontmatter.name, rel);
    } catch {
      // Existing invalid definitions are reported by Claude Code/doctor; do not mask scaffold validation.
    }
  }
  return names;
}

function validateAdapterObject(adapter, root, plannedPaths = new Set()) {
  const errors = [];
  const warnings = [];
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) return { errors: ["adapter: must be a JSON object"], warnings };
  for (const field of Object.keys(adapter)) if (!["version", "provider", "routing", "qualityGates"].includes(field)) errors.push(`adapter: unsupported field ${field}`);
  if (adapter.version !== 1) errors.push("adapter: version must be 1");
  if (adapter.provider !== undefined) {
    if (!adapter.provider || typeof adapter.provider !== "object" || Array.isArray(adapter.provider)) {
      errors.push("adapter: provider must be an object");
    } else {
      for (const field of Object.keys(adapter.provider)) if (field !== "workItems") errors.push(`adapter: provider has unsupported field ${field}`);
      if (adapter.provider.workItems !== undefined && !["github", "azure-devops", "none"].includes(adapter.provider.workItems)) {
        errors.push("adapter: provider.workItems must be github, azure-devops, or none");
      }
    }
  }
  if (adapter.routing !== undefined && (typeof adapter.routing !== "object" || Array.isArray(adapter.routing))) {
    errors.push("adapter: routing must be an object");
  }
  for (const [stage, route] of Object.entries(adapter.routing || {})) {
    if (!ALLOWED_STAGES.has(stage)) errors.push(`adapter: unsupported route stage ${stage}`);
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      errors.push(`adapter: routing.${stage} must be an object`);
      continue;
    }
    for (const field of Object.keys(route)) if (!["agent", "skills"].includes(field)) errors.push(`adapter: routing.${stage} has unsupported field ${field}`);
    if (route.agent !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route.agent)) {
      errors.push(`adapter: routing.${stage}.agent must be an unscoped kebab-case project agent name`);
    }
    if (route.agent) {
      const agentPathExists = [...plannedPaths].some((path) => path.startsWith(".claude/agents/") && path.endsWith(".md")) || existsSync(join(root, ".claude", "agents"));
      if (!agentPathExists) warnings.push(`adapter: route ${stage} references ${route.agent}; verify the project agent exists`);
    }
    if (route.skills !== undefined && (!Array.isArray(route.skills) || route.skills.some((name) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)))) {
      errors.push(`adapter: routing.${stage}.skills must contain unscoped kebab-case project skill names`);
    }
  }
  if (adapter.qualityGates !== undefined && (!adapter.qualityGates || typeof adapter.qualityGates !== "object" || Array.isArray(adapter.qualityGates))) {
    errors.push("adapter: qualityGates must be an object");
  }
  if (adapter.qualityGates && typeof adapter.qualityGates === "object" && !Array.isArray(adapter.qualityGates)) {
    for (const field of Object.keys(adapter.qualityGates)) if (field !== "required") errors.push(`adapter: qualityGates has unsupported field ${field}`);
  }
  const gates = adapter.qualityGates?.required || [];
  if (!Array.isArray(gates)) errors.push("adapter: qualityGates.required must be an array");
  for (const [index, gate] of (Array.isArray(gates) ? gates : []).entries()) {
    const prefix = `adapter: qualityGates.required[${index}]`;
    if (!gate || typeof gate !== "object") {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const field of Object.keys(gate)) if (!["id", "command", "source", "timeoutSeconds"].includes(field)) errors.push(`${prefix} has unsupported field ${field}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gate.id || "")) errors.push(`${prefix}.id must be kebab-case`);
    if (typeof gate.command !== "string" || !gate.command.trim() || /[\r\n]/.test(gate.command)) errors.push(`${prefix}.command must be one non-empty line`);
    if (DESTRUCTIVE_COMMAND.test(gate.command || "")) errors.push(`${prefix}.command contains a destructive or deployment operation`);
    if (UNSAFE_SHELL_SYNTAX.test(gate.command || "")) errors.push(`${prefix}.command contains unsupported shell control syntax; wrap complex checks in a reviewed repository task script`);
    if ((gate.command || "").includes("&&") && !/^cd\s+"?[A-Za-z0-9_./ -]+"?\s+&&\s+[A-Za-z0-9_.-]+(?:\s|$)/.test(gate.command)) {
      errors.push(`${prefix}.command uses an unsupported command chain`);
    }
    if (EXTERNAL_SIDE_EFFECT_COMMAND.test(gate.command || "")) errors.push(`${prefix}.command performs an external or deployment side effect, not a quality check`);
    if (typeof gate.source !== "string" || !gate.source.trim()) errors.push(`${prefix}.source is required`);
    if (typeof gate.source === "string" && gate.source.trim()) {
      const sourcePath = gate.source.split("#", 1)[0];
      const normalizedSource = normalizeRelativePath(sourcePath);
      if (!normalizedSource || SENSITIVE_PATH.test(normalizedSource)) errors.push(`${prefix}.source must be a safe repository-relative file reference`);
      else {
        try {
          const sourceTarget = resolveInside(root, normalizedSource).target;
          if (!existsSync(sourceTarget) || !statSync(sourceTarget).isFile()) errors.push(`${prefix}.source does not exist: ${normalizedSource}`);
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
    if (gate.timeoutSeconds !== undefined && (!Number.isInteger(gate.timeoutSeconds) || gate.timeoutSeconds < 1 || gate.timeoutSeconds > 7_200)) {
      errors.push(`${prefix}.timeoutSeconds must be between 1 and 7200`);
    }
  }
  return { errors, warnings };
}

function validateMarkdownLinks(artifact, root, plannedPaths) {
  const errors = [];
  for (const match of artifact.content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().split("#", 1)[0];
    if (!raw || /^(?:https?:|mailto:|#)/i.test(raw)) continue;
    const linkTarget = resolve(dirname(join(root, artifact.path)), raw);
    if (linkTarget !== root && !linkTarget.startsWith(`${root}${sep}`)) {
      errors.push(`${artifact.path}: link escapes repository root: ${match[1]}`);
      continue;
    }
    const rel = relative(root, linkTarget).replaceAll("\\", "/");
    if (!plannedPaths.has(rel) && !existsSync(linkTarget)) errors.push(`${artifact.path}: broken local link ${match[1]}`);
  }
  return errors;
}

function validateArtifactContent(artifact, root, allArtifacts, existingNames) {
  const errors = [];
  const warnings = [];
  const lines = artifact.content.split(/\r?\n/);
  if (artifact.content.includes(root)) errors.push(`${artifact.path}: embeds the current absolute repository path`);
  if (/\b(?:TODO|TBD|FIXME|YOUR_[A-Z0-9_]+|<repo(?:sitory)?>)\b/.test(artifact.content)) errors.push(`${artifact.path}: contains an unresolved placeholder`);
  for (const pattern of SECRET_CONTENT) if (pattern.test(artifact.content)) errors.push(`${artifact.path}: appears to contain a secret or private key`);

  if (artifact.kind === "instructions" && lines.length > 220) warnings.push(`${artifact.path}: always-loaded instructions exceed 220 lines; move detail to references or skills`);
  if (artifact.kind === "rule") {
    try {
      const frontmatter = parseFrontmatter(artifact.content, artifact.path);
      if (!Object.hasOwn(frontmatter, "paths")) errors.push(`${artifact.path}: generated rules must be path-scoped with paths frontmatter`);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (artifact.kind === "skill") {
    try {
      const frontmatter = parseFrontmatter(artifact.content, artifact.path);
      const folder = artifact.path.split("/")[2];
      if (!frontmatter.name) errors.push(`${artifact.path}: missing skill name`);
      if (!frontmatter.description) errors.push(`${artifact.path}: missing skill description`);
      if (frontmatter.name && frontmatter.name !== folder) errors.push(`${artifact.path}: skill name must match its directory (${folder})`);
      if (frontmatter.name && existingNames.skills.has(frontmatter.name)) errors.push(`${artifact.path}: duplicate project skill name also defined at ${existingNames.skills.get(frontmatter.name)}`);
      if (lines.length > 500) errors.push(`${artifact.path}: SKILL.md exceeds 500 lines`);
      if (/\b(?:Write|Edit)\b/.test(frontmatter["allowed-tools"] || "") && frontmatter["disable-model-invocation"] !== "true") {
        warnings.push(`${artifact.path}: a write-capable skill should normally set disable-model-invocation: true`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (artifact.kind === "agent") {
    try {
      const frontmatter = parseFrontmatter(artifact.content, artifact.path);
      for (const field of ["name", "description", "model", "tools"]) if (!frontmatter[field]) errors.push(`${artifact.path}: missing agent ${field}`);
      if (frontmatter.name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name)) errors.push(`${artifact.path}: agent name must be kebab-case`);
      if (frontmatter.name && existingNames.agents.has(frontmatter.name)) errors.push(`${artifact.path}: duplicate project agent name also defined at ${existingNames.agents.get(frontmatter.name)}`);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (artifact.kind === "adapter") {
    try {
      const adapter = JSON.parse(artifact.content);
      const result = validateAdapterObject(adapter, root, new Set(allArtifacts.map(({ path }) => path)));
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    } catch (error) {
      errors.push(`${artifact.path}: invalid adapter JSON (${error.message})`);
    }
  }
  return { errors, warnings };
}

export function validateBlueprint(blueprint, rootInput = process.cwd()) {
  const root = resolve(rootInput);
  const errors = [];
  const warnings = [];
  const operations = [];
  if (!blueprint || typeof blueprint !== "object" || Array.isArray(blueprint)) {
    return { valid: false, errors: ["Blueprint must be a JSON object"], warnings, operations, approvalDigest: null };
  }
  const allowedBlueprintFields = new Set(["schemaVersion", "pluginVersion", "summary", "artifacts"]);
  for (const field of Object.keys(blueprint)) if (!allowedBlueprintFields.has(field)) errors.push(`Unsupported blueprint field: ${field}`);
  if (blueprint.schemaVersion !== SCAFFOLD_VERSION) errors.push(`schemaVersion must be ${SCAFFOLD_VERSION}`);
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(blueprint.pluginVersion || "")) errors.push("pluginVersion must be semver");
  if (typeof blueprint.summary !== "string" || !blueprint.summary.trim() || blueprint.summary.length > 2_000) errors.push("summary must be 1-2000 characters");
  if (!Array.isArray(blueprint.artifacts) || blueprint.artifacts.length === 0) errors.push("artifacts must be a non-empty array");
  if ((blueprint.artifacts?.length || 0) > MAX_ARTIFACTS) errors.push(`artifacts cannot exceed ${MAX_ARTIFACTS}`);
  const artifacts = Array.isArray(blueprint.artifacts) ? blueprint.artifacts : [];
  const seenPaths = new Set();
  let totalBytes = 0;
  const normalizedArtifacts = [];

  for (const [index, artifact] of artifacts.entries()) {
    const prefix = `artifacts[${index}]`;
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    const allowedArtifactFields = new Set(["path", "kind", "operation", "expectedSha256", "rationale", "evidence", "content", "executable"]);
    for (const field of Object.keys(artifact)) if (!allowedArtifactFields.has(field)) errors.push(`${prefix}: unsupported field ${field}`);
    const path = normalizeRelativePath(artifact.path);
    if (!path) {
      errors.push(`${prefix}.path must be a safe repository-relative path`);
      continue;
    }
    if (seenPaths.has(path)) errors.push(`${prefix}.path duplicates ${path}`);
    seenPaths.add(path);
    if (!ALLOWED_KINDS.has(artifact.kind)) errors.push(`${prefix}.kind is unsupported`);
    if (!allowedTarget(path, artifact.kind)) errors.push(`${prefix}: ${path} is not an allowed target for kind ${artifact.kind}`);
    if (!["create", "replace"].includes(artifact.operation)) errors.push(`${prefix}.operation must be create or replace`);
    if (typeof artifact.rationale !== "string" || !artifact.rationale.trim()) errors.push(`${prefix}.rationale is required`);
    if (!Array.isArray(artifact.evidence) || artifact.evidence.length === 0) errors.push(`${prefix}.evidence must name at least one repository source`);
    if (typeof artifact.content !== "string" || !artifact.content.trim()) errors.push(`${prefix}.content must be non-empty text`);
    if (artifact.executable === true && !/^\.claude\/skills\/[^/]+\/scripts\//.test(path)) errors.push(`${prefix}.executable is allowed only for skill-local scripts`);
    const bytes = Buffer.byteLength(artifact.content || "");
    totalBytes += bytes;
    if (bytes > MAX_FILE_BYTES) errors.push(`${prefix}.content exceeds ${MAX_FILE_BYTES} bytes`);
    let target;
    try {
      target = resolveInside(root, path).target;
      if (hasSymlinkAncestor(root, target)) errors.push(`${prefix}.path traverses a symlink`);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    for (const evidence of Array.isArray(artifact.evidence) ? artifact.evidence : []) {
      const normalizedEvidence = normalizeRelativePath(evidence);
      if (!normalizedEvidence || SENSITIVE_PATH.test(normalizedEvidence)) {
        errors.push(`${prefix}.evidence contains an unsafe or sensitive path: ${String(evidence)}`);
        continue;
      }
      try {
        const evidenceTarget = resolveInside(root, normalizedEvidence).target;
        if (!existsSync(evidenceTarget)) errors.push(`${prefix}.evidence does not exist: ${normalizedEvidence}`);
        else if (hasSymlinkAncestor(root, evidenceTarget) || !statSync(evidenceTarget).isFile()) errors.push(`${prefix}.evidence must be a regular non-symlink file: ${normalizedEvidence}`);
      } catch (error) {
        errors.push(error.message);
      }
    }
    const exists = existsSync(target);
    const currentContent = exists && statSync(target).isFile() ? readFileSync(target, "utf8") : null;
    const currentHash = currentContent === null ? null : sha256(currentContent);
    if (exists && currentContent === null) errors.push(`${prefix}.path is not a regular file`);
    if (artifact.operation === "create" && exists) errors.push(`${prefix}: create target already exists: ${path}`);
    if (artifact.operation === "replace" && !exists) errors.push(`${prefix}: replace target does not exist: ${path}`);
    if (exists && artifact.expectedSha256 !== currentHash) errors.push(`${prefix}.expectedSha256 must exactly match the current file hash`);
    if (!exists && artifact.expectedSha256 !== undefined && artifact.expectedSha256 !== null) errors.push(`${prefix}.expectedSha256 must be omitted for a create`);
    normalizedArtifacts.push({ ...artifact, path, target, currentHash, bytes });
    operations.push({ path, kind: artifact.kind, operation: artifact.operation, currentSha256: currentHash, proposedSha256: sha256(artifact.content || "") });
  }
  if (totalBytes > MAX_TOTAL_BYTES) errors.push(`Blueprint content exceeds ${MAX_TOTAL_BYTES} total bytes`);

  const ignoredTargets = new Set(normalizedArtifacts.map(({ path }) => path));
  const existingNames = {
    skills: collectExistingDefinitions(root, "skills", ignoredTargets),
    agents: collectExistingDefinitions(root, "agents", ignoredTargets),
  };
  const proposedNames = { skills: new Map(), agents: new Map() };
  for (const artifact of normalizedArtifacts) {
    const result = validateArtifactContent(artifact, root, normalizedArtifacts, existingNames);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    if (["skill", "agent"].includes(artifact.kind)) {
      try {
        const name = parseFrontmatter(artifact.content, artifact.path).name;
        const category = `${artifact.kind}s`;
        if (name && proposedNames[category].has(name)) errors.push(`${artifact.path}: duplicate proposed ${artifact.kind} name ${name}`);
        if (name) proposedNames[category].set(name, artifact.path);
      } catch {
        // Reported by content validation.
      }
    }
  }
  const availableSkills = new Set([...existingNames.skills.keys(), ...proposedNames.skills.keys()]);
  const availableAgents = new Set([...existingNames.agents.keys(), ...proposedNames.agents.keys()]);
  for (const artifact of normalizedArtifacts.filter(({ kind }) => kind === "adapter")) {
    try {
      const adapter = JSON.parse(artifact.content);
      for (const [stage, route] of Object.entries(adapter.routing || {})) {
        if (route.agent && !availableAgents.has(route.agent)) errors.push(`${artifact.path}: route ${stage} references missing project agent ${route.agent}`);
        for (const skill of route.skills || []) if (!availableSkills.has(skill)) errors.push(`${artifact.path}: route ${stage} references missing project skill ${skill}`);
      }
    } catch {
      // Invalid JSON is reported by content validation.
    }
  }
  const plannedPaths = new Set(normalizedArtifacts.map(({ path }) => path));
  for (const artifact of normalizedArtifacts.filter(({ path }) => path.endsWith(".md"))) {
    errors.push(...validateMarkdownLinks(artifact, root, plannedPaths));
  }
  for (const reference of normalizedArtifacts.filter(({ kind }) => kind === "reference")) {
    const linked = normalizedArtifacts.some((artifact) => artifact.path !== reference.path && artifact.content.includes(basename(reference.path)));
    if (!linked) warnings.push(`${reference.path}: reference is not linked by another proposed artifact`);
  }

  const digestInput = JSON.stringify({
    schemaVersion: blueprint.schemaVersion,
    pluginVersion: blueprint.pluginVersion,
    summary: blueprint.summary,
    artifacts: normalizedArtifacts.map(({ target, currentHash, bytes, ...artifact }) => artifact),
  });
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    operations,
    approvalDigest: errors.length ? null : sha256(digestInput),
  };
}

function buildManifest(blueprint, validation, previousManifest = null) {
  const touched = new Set(validation.operations.map(({ path }) => path));
  const stale = (previousManifest?.artifacts || [])
    .filter((artifact) => !touched.has(artifact.path))
    .map((artifact) => ({ ...artifact, stale: true }));
  return {
    schemaVersion: SCAFFOLD_VERSION,
    pluginVersion: blueprint.pluginVersion || DEFAULT_PLUGIN_VERSION,
    blueprintDigest: validation.approvalDigest,
    generatedAt: new Date().toISOString(),
    artifacts: [
      ...validation.operations.map((operation) => ({
        path: operation.path,
        kind: operation.kind,
        sha256: operation.proposedSha256,
        evidence: blueprint.artifacts.find((artifact) => normalizeRelativePath(artifact.path) === operation.path)?.evidence || [],
        stale: false,
      })),
      ...stale,
    ].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function applyBlueprint(blueprint, { root: rootInput = process.cwd(), approval } = {}) {
  const root = resolve(rootInput);
  const validation = validateBlueprint(blueprint, root);
  if (!validation.valid) throw new Error(`Blueprint validation failed:\n- ${validation.errors.join("\n- ")}`);
  if (!approval || approval !== validation.approvalDigest) throw new Error("Approval digest is missing or does not match the validated blueprint");

  const manifestTarget = join(root, MANIFEST_PATH);
  let previousManifest = null;
  if (existsSync(manifestTarget)) previousManifest = readJson(manifestTarget);
  const manifest = buildManifest(blueprint, validation, previousManifest);
  const backups = [];
  try {
    for (const artifact of blueprint.artifacts) {
      const { normalized: path, target } = resolveInside(root, artifact.path);
      if (hasSymlinkAncestor(root, target)) throw new Error(`Refusing to write through symlink: ${path}`);
      const existed = existsSync(target);
      if (existed && sha256(readFileSync(target, "utf8")) !== artifact.expectedSha256) throw new Error(`Target changed after validation: ${path}`);
      backups.push({ target, existed, content: existed ? readFileSync(target) : null, mode: existed ? statSync(target).mode : null });
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, artifact.content, { encoding: "utf8", flag: existed ? "w" : "wx" });
      if (artifact.executable === true) chmodSync(target, 0o755);
    }
    const manifestExisted = existsSync(manifestTarget);
    backups.push({ target: manifestTarget, existed: manifestExisted, content: manifestExisted ? readFileSync(manifestTarget) : null, mode: manifestExisted ? statSync(manifestTarget).mode : null });
    mkdirSync(dirname(manifestTarget), { recursive: true });
    writeFileSync(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const verification = verifyScaffold(root);
    if (!verification.valid) throw new Error(`Scaffold verification failed:\n- ${verification.errors.join("\n- ")}`);
    return { applied: validation.operations, manifest: MANIFEST_PATH, approvalDigest: validation.approvalDigest, verification };
  } catch (error) {
    for (const backup of backups.reverse()) {
      try {
        if (backup.existed) {
          mkdirSync(dirname(backup.target), { recursive: true });
          writeFileSync(backup.target, backup.content);
          if (backup.mode !== null) chmodSync(backup.target, backup.mode);
        } else if (existsSync(backup.target)) {
          rmSync(backup.target, { force: true });
        }
      } catch {
        // Preserve the original failure; verification will report any rollback drift.
      }
    }
    throw error;
  }
}

function definitionNames(root, category) {
  const names = new Set();
  const base = join(root, ".claude", category);
  if (!existsSync(base)) return names;
  for (const file of walk(base, { maxDepth: 6, maxEntries: 5_000 }).files.filter((candidate) => candidate.endsWith(".md"))) {
    try {
      const frontmatter = parseFrontmatter(readFileSync(file, "utf8"), relative(root, file));
      if (frontmatter.name) names.add(frontmatter.name);
    } catch {
      // Validation below will surface malformed managed files; unmanaged files remain Claude Code's concern.
    }
  }
  return names;
}

export function verifyScaffold(rootInput = process.cwd()) {
  const root = resolve(rootInput);
  const errors = [];
  const warnings = [];
  const manifestTarget = join(root, MANIFEST_PATH);
  let manifest = null;
  if (existsSync(manifestTarget)) {
    try {
      manifest = readJson(manifestTarget);
      if (manifest.schemaVersion !== SCAFFOLD_VERSION) errors.push(`Manifest schemaVersion must be ${SCAFFOLD_VERSION}`);
      for (const artifact of manifest.artifacts || []) {
        const { target } = resolveInside(root, artifact.path);
        if (!existsSync(target)) {
          errors.push(`Managed artifact is missing: ${artifact.path}`);
          continue;
        }
        const actual = sha256(readFileSync(target, "utf8"));
        if (actual !== artifact.sha256) errors.push(`Managed artifact drift: ${artifact.path}`);
        if (artifact.stale) warnings.push(`Managed artifact is stale and requires an explicit keep/update/remove decision: ${artifact.path}`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  const adapterTarget = join(root, ".claude", "asterweave.json");
  let adapter = null;
  if (existsSync(adapterTarget)) {
    try {
      adapter = readJson(adapterTarget);
      const result = validateAdapterObject(adapter, root);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      const agents = definitionNames(root, "agents");
      const skills = definitionNames(root, "skills");
      for (const [stage, route] of Object.entries(adapter.routing || {})) {
        if (route.agent && !agents.has(route.agent)) errors.push(`Adapter route ${stage} references missing project agent ${route.agent}`);
        for (const skill of route.skills || []) if (!skills.has(skill)) errors.push(`Adapter route ${stage} references missing project skill ${skill}`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], manifest: Boolean(manifest), adapter: Boolean(adapter) };
}

export function resolveRoute(stage, rootInput = process.cwd()) {
  if (!ALLOWED_STAGES.has(stage)) throw new Error(`Unsupported route stage: ${stage}`);
  const root = resolve(rootInput);
  const verification = verifyScaffold(root);
  if (!verification.valid) throw new Error(`Repository adapter is invalid:\n- ${verification.errors.join("\n- ")}`);
  const adapterTarget = join(root, ".claude", "asterweave.json");
  const adapter = existsSync(adapterTarget) ? readJson(adapterTarget) : { version: 1 };
  return {
    stage,
    route: adapter.routing?.[stage] || null,
    requiredQualityGates: adapter.qualityGates?.required || [],
    precedence: ["managed security", "Asterweave safety/evidence", "repository policy", "approved task", "plugin defaults"],
  };
}

function parseCli(argv) {
  const [command = "inventory", ...rest] = argv;
  const positional = [];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--approval" || value === "--root") options[value.slice(2)] = rest[++index];
    else positional.push(value);
  }
  return { command, positional, options };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const { command, positional, options } = parseCli(process.argv.slice(2));
    let result;
    if (command === "inventory") result = inventoryRepository(options.root || positional[0] || process.cwd());
    else if (command === "plan") {
      if (!positional[0]) throw new Error("Usage: scaffold-repo.mjs plan <blueprint.json> [--root <repository>]");
      result = validateBlueprint(readJson(resolve(positional[0])), options.root || positional[1] || process.cwd());
    } else if (command === "apply") {
      if (!positional[0]) throw new Error("Usage: scaffold-repo.mjs apply <blueprint.json> --approval <digest> [--root <repository>]");
      result = applyBlueprint(readJson(resolve(positional[0])), { root: options.root || positional[1] || process.cwd(), approval: options.approval });
    } else if (command === "verify") result = verifyScaffold(options.root || positional[0] || process.cwd());
    else if (command === "route") {
      if (!positional[0]) throw new Error("Usage: scaffold-repo.mjs route <stage> [--root <repository>]");
      result = resolveRoute(positional[0], options.root || positional[1] || process.cwd());
    } else throw new Error(`Unknown scaffold command: ${command}`);
    console.log(JSON.stringify(result, null, 2));
    if (result.valid === false) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
