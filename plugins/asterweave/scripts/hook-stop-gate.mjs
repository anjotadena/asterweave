#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export function evaluateStop(payload, cwd = process.cwd()) {
  if (payload?.stop_hook_active) return null;
  const statePath = resolve(cwd, ".claude", "asterweave", "state.json");
  if (!existsSync(statePath)) return null;

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }

  if (state.status !== "active" || state.currentNode === "done") return null;
  if (state.currentNode === "approve") return null;
  const node = state.nodes?.[state.currentNode];
  const message = [
    `Asterweave workflow ${state.workflowId} is still active at node '${state.currentNode}'.`,
    `Node status: ${node?.status ?? "unknown"}; attempts: ${node?.attempts ?? 0}/${node?.maxAttempts ?? "?"}.`,
    "Continue the current graph node, record environment evidence, and transition through graph-state.mjs.",
    "If human input is genuinely required, record a needs-human outcome so the workflow becomes blocked and the turn may end.",
  ].join(" ");
  return {
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: message,
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    payload = {};
  }
  const output = evaluateStop(payload);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}
