#!/usr/bin/env node

// Optional context-budget trigger for `/asterweave:handoff`. Inert unless a threshold is
// configured (`handoff.contextBudget.warnAtTokens` in .claude/asterweave.json, or the
// ASTERWEAVE_HANDOFF_WARN_TOKENS environment variable).
//
// Claude Code does not expose the model's context-window size or remaining tokens to hooks.
// The transcript does record per-request API usage, so this hook reads the most recent
// main-conversation usage entry as an approximation of the current context size and compares
// it with the configured threshold. When usage is unavailable it does nothing.
//
// It fires only at Stop (never per tool call), never writes a handoff itself, and asks for a
// refresh at most once per session per threshold band.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ensureNotCommitted, readHandoffConfig, repositoryRoot } from "./handoff-state.mjs";

const TAIL_BYTES = 512 * 1024;
const BAND_STEP = 0.25;
const MIN_BAND_TOKENS = 10_000;
const MIN_THRESHOLD = 1_000;

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function readTail(file) {
  const size = statSync(file).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = openSync(file, "r");
  try {
    readSync(handle, buffer, 0, length, size - length);
  } finally {
    closeSync(handle);
  }
  return buffer.toString("utf8");
}

// Returns the approximate token count of the latest main-conversation request, or null.
export function latestContextTokens(transcriptPath) {
  if (typeof transcriptPath !== "string" || !existsSync(transcriptPath)) return null;
  let lines;
  try {
    lines = readTail(transcriptPath).split(/\r?\n/);
  } catch {
    return null;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    const usage = entry.message?.usage;
    if (!usage || typeof usage !== "object") continue;
    const total = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]
      .map((key) => (Number.isFinite(usage[key]) ? usage[key] : 0))
      .reduce((sum, value) => sum + value, 0);
    if (total > 0) return total;
  }
  return null;
}

export function resolveThreshold(cwd, env = process.env) {
  const fromEnv = Number.parseInt(env.ASTERWEAVE_HANDOFF_WARN_TOKENS ?? "", 10);
  if (Number.isInteger(fromEnv) && fromEnv >= MIN_THRESHOLD) return fromEnv;
  return readHandoffConfig(cwd).warnAtTokens;
}

function markerPath(cwd) {
  return join(cwd, ".claude", "asterweave", "handoffs", ".reminders.json");
}

function readMarkers(cwd) {
  try {
    return JSON.parse(readFileSync(markerPath(cwd), "utf8"));
  } catch {
    return {};
  }
}

export function evaluateReminder(payload, { cwd = process.cwd(), env = process.env } = {}) {
  if (payload?.stop_hook_active) return null;
  // Config and marker live at the repository root even when Claude runs from a subdirectory.
  const root = repositoryRoot(resolve(payload?.cwd || cwd));
  const threshold = resolveThreshold(root, env);
  if (!threshold) return null;
  const tokens = latestContextTokens(payload?.transcript_path);
  if (tokens === null || tokens < threshold) return null;

  const band = Math.floor((tokens - threshold) / Math.max(threshold * BAND_STEP, MIN_BAND_TOKENS));
  const session = String(payload?.session_id || "unknown");
  const markers = readMarkers(root);
  if (Number.isInteger(markers[session]?.band) && markers[session].band >= band) return null;

  // Keep the marker small: only the ten most recent sessions.
  const next = Object.fromEntries(
    Object.entries({ ...markers, [session]: { band, tokens, at: new Date().toISOString() } })
      .sort(([, left], [, right]) => String(right.at).localeCompare(String(left.at)))
      .slice(0, 10),
  );
  try {
    ensureNotCommitted(root);
    writeFileSync(markerPath(root), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Without a marker the reminder may repeat once more; never fail the turn over it.
  }

  const approx = `about ${Math.round(tokens / 1000)}k tokens (last recorded API usage; not an exact remaining-token count)`;
  return {
    decision: "block",
    reason: [
      `Context usage is ${approx}, at or above the configured handoff threshold of ${threshold}.`,
      "Refresh the session handoff now with /asterweave:handoff (create), recording only evidence you actually observed.",
      "Then end the turn; do not start new implementation work in this response.",
    ].join(" "),
    systemMessage: `Asterweave: context is ${approx}; asking Claude to refresh the handoff once before stopping.`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || "{}");
  } catch {
    payload = {};
  }
  try {
    const output = evaluateReminder(payload);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    // Fail open: a reminder must never break a session.
  }
}
