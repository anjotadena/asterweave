#!/usr/bin/env node

// PreToolUse hook (Edit|Write|NotebookEdit) enforcing the write-ownership boundary of an active
// `/asterweave:complete-project` module worker (see references/project-completion.md, Phase 12).
//
// Ownership is not centrally polled: each worker writes its own bounded manifest to
// `.claude/asterweave/completion-worker.json` inside its isolated worktree as its first action
// (see the worker context-manifest contract). This hook reads that local file and denies any
// Edit/Write/NotebookEdit whose target path is not inside the worker's `write` (or
// orchestrator-approved `approvedShared`) boundary. A session with no such manifest is not a
// completion worker, so this hook is a no-op for every other Asterweave workflow.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { matchesAny, normalizePath } from "./lib/glob-match.mjs";

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function manifestPath(cwd) {
  return resolve(cwd, ".claude", "asterweave", "completion-worker.json");
}

function relativeToCwd(filePath, cwd) {
  const absoluteFile = resolve(filePath);
  const absoluteCwd = resolve(cwd);
  if (absoluteFile.toLowerCase().startsWith(absoluteCwd.toLowerCase())) {
    return normalizePath(absoluteFile.slice(absoluteCwd.length));
  }
  return normalizePath(filePath);
}

function denyResult(manifest, path, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `WRITE DENIED — worker '${manifest.workstreamId}' (${manifest.module}) attempted '${path}'. ${reason}`,
    },
  };
}

export function evaluateWrite(payload, cwd = process.cwd()) {
  if (process.env.ASTERWEAVE_DISABLE_OWNERSHIP_GUARD === "1") return null;
  const toolName = payload?.tool_name;
  if (!WRITE_TOOLS.has(toolName)) return null;
  const filePath = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  if (typeof filePath !== "string" || !filePath.trim()) return null;

  const path = manifestPath(cwd);
  if (!existsSync(path)) return null; // no active completion-worker manifest: not our concern

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!manifest?.workstreamId) return null;

  const relative = relativeToCwd(filePath, cwd);
  const deny = manifest.deny || [];
  const write = manifest.write || [];
  const approvedShared = manifest.approvedShared || [];
  const shared = manifest.shared || [];

  if (matchesAny(deny, relative)) {
    return denyResult(manifest, relative, "Path is owned by another workstream.");
  }
  if (matchesAny(write, relative) || matchesAny(approvedShared, relative)) {
    return null;
  }
  if (matchesAny(shared, relative)) {
    return denyResult(
      manifest,
      relative,
      "Path is shared/core code. File a Shared Change Request with the orchestrator instead of editing it directly.",
    );
  }
  return denyResult(manifest, relative, "Path is outside this workstream's approved write boundary.");
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export async function runHook(rawInput, cwd = process.cwd()) {
  let payload;
  try {
    payload = JSON.parse(rawInput || "{}");
  } catch {
    return { exitCode: 0, stdout: "" };
  }
  const decision = evaluateWrite(payload, cwd);
  if (!decision) return { exitCode: 0, stdout: "" };
  return { exitCode: 0, stdout: JSON.stringify(decision) };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await runHook(await readStdin());
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  process.exitCode = result.exitCode;
}
