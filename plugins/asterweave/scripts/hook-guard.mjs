#!/usr/bin/env node

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
  if (!decision.blocked) return { exitCode: 0, stdout: "" };
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
