#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const DEFAULT_BRANCHES = new Set(["main", "master"]);

const BLOCKED_PATTERNS = [
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard can destroy uncommitted work" },
  { pattern: /\bgit\s+clean\s+-[^\s]*f/i, reason: "git clean with force can delete untracked files" },
  { pattern: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.\s*(?:$|[;&|])/i, reason: "bulk checkout/restore can discard user changes" },
  { pattern: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|\s-f(?:\s|$))/i, reason: "force-push requires an explicit manual operation" },
  { pattern: /\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)\s+(?:\/|~|\.\.?|\$HOME)(?:\s|$)/i, reason: "broad recursive deletion is prohibited" },
  { pattern: /\bRemove-Item\b[^\n]*-(?:Recurse|r)\b[^\n]*-(?:Force|fo)\b[^\n]*(?:\\|\/|\$HOME|\$env:USERPROFILE)(?:\s|$)/i, reason: "broad recursive PowerShell deletion is prohibited" },
  { pattern: /\b(?:DROP\s+(?:DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, reason: "destructive database operations require a separate approved runbook" },
  { pattern: /\bdocker\s+system\s+prune\b[^\n]*-a/i, reason: "global Docker pruning can remove unrelated data" },
  { pattern: /\bkubectl\s+delete\s+(?:namespace|ns)\b/i, reason: "namespace deletion is outside autonomous coding scope" },
  { pattern: /\bterraform\s+destroy\b/i, reason: "infrastructure destruction is outside autonomous coding scope" },
];

export function evaluateCommand(command) {
  if (process.env.ASTERWEAVE_DISABLE_DESTRUCTIVE_GUARD === "1") {
    return { blocked: false, reason: null };
  }
  for (const entry of BLOCKED_PATTERNS) {
    if (entry.pattern.test(command)) return { blocked: true, reason: entry.reason };
  }
  return { blocked: false, reason: null };
}

function currentBranch(cwd) {
  try {
    return execFileSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function refName(ref) {
  return ref.replace(/^\+/, "").replace(/^refs\/heads\//, "");
}

// Finds a `git push` that lands work on a default branch without a pull request: an explicit
// main/master refspec, --all/--mirror, or a bare push while main/master is checked out.
// Asterweave lands work through submit-pr, so these need the user's explicit say-so.
export function evaluatePush(command, { cwd = process.cwd(), branchOf = currentBranch } = {}) {
  if (process.env.ASTERWEAVE_DISABLE_DESTRUCTIVE_GUARD === "1" || process.env.ASTERWEAVE_ALLOW_DEFAULT_BRANCH_PUSH === "1") {
    return { ask: false, reason: null };
  }
  for (const segment of command.split(/&&|\|\||[;\n|]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const git = tokens.indexOf("git");
    if (git === -1) continue;
    let directory = cwd;
    let index = git + 1;
    while (index < tokens.length && tokens[index].startsWith("-")) {
      if (tokens[index] === "-C" && tokens[index + 1]) {
        directory = resolve(cwd, tokens[index + 1].replace(/^['"]|['"]$/g, ""));
        index += 1;
      }
      index += 1;
    }
    if (tokens[index] !== "push") continue;
    const rest = tokens.slice(index + 1);
    if (rest.some((token) => token === "--all" || token === "--mirror")) {
      return { ask: true, reason: "pushing every branch can land work on the default branch without a pull request" };
    }
    if (rest.some((token) => token === "--delete" || token === "-d")) continue;
    const positional = rest.filter((token) => !token.startsWith("-"));
    const refspecs = positional.slice(1);
    if (!refspecs.length && rest.includes("--tags")) continue;
    const targets = refspecs.length
      ? refspecs.map((spec) => refName(spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec))
      : [branchOf(directory)].filter(Boolean);
    const target = targets.find((name) => DEFAULT_BRANCHES.has(name));
    if (target) return { ask: true, reason: `this pushes directly to '${target}' instead of landing through a pull request` };
  }
  return { ask: false, reason: null };
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export async function runHook(rawInput) {
  let payload;
  try {
    payload = JSON.parse(rawInput || "{}");
  } catch {
    return { exitCode: 0, stdout: "" };
  }
  const command = payload?.tool_input?.command ?? payload?.tool_input?.script ?? "";
  if (typeof command !== "string") return { exitCode: 0, stdout: "" };
  const decision = evaluateCommand(command);
  if (!decision.blocked) {
    const push = evaluatePush(command, { cwd: typeof payload?.cwd === "string" ? payload.cwd : process.cwd() });
    if (!push.ask) return { exitCode: 0, stdout: "" };
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `Asterweave: ${push.reason}. Asterweave lands work through /asterweave:submit-pr and CI; approve only if you asked for a direct push.`,
        },
      }),
    };
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Asterweave blocked this command: ${decision.reason}. Preserve user data and choose a reversible alternative.`,
      },
    }),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await runHook(await readStdin());
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  process.exitCode = result.exitCode;
}
