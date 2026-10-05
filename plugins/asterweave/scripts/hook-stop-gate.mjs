#!/usr/bin/env node

// Stop hook: auto-continue for long Asterweave runs.
//
// Keeps a `deliver` graph or a `complete-project` run going instead of waiting for a human
// "continue", while a ledger that THIS session wrote still has unfinished work. The stop is let
// through when:
//   - no Asterweave ledger was written during this session, or every one it wrote is finished,
//     blocked, paused, or waiting at a deliberate approval checkpoint;
//   - Claude ended on a question to the user (a real escalation);
//   - neither the ledgers nor the working tree changed across the last two nudges (stalled);
//   - the per-session nudge cap was reached (`autoContinue.maxNudges`, default 25);
//   - the configured handoff context budget was reached (the handoff reminder takes over);
//   - it is disabled: `autoContinue.enabled: false` in .claude/asterweave.json, the
//     ASTERWEAVE_NO_AUTOCONTINUE=1 environment variable, or a `.claude/asterweave/.no-autocontinue`
//     file.
//
// It keeps its own nudge counter instead of honoring `stop_hook_active`, because that flag would
// cap it at one nudge per human turn, which is exactly the "continue" loop this hook removes.
// Per-session counters live in the OS temp directory, never in the repository.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { latestContextTokens, resolveThreshold } from "./hook-handoff-reminder.mjs";
import { repositoryRoot } from "./handoff-state.mjs";

export const DEFAULT_MAX_NUDGES = 25;
const MAX_STALLS = 2;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readSlice(file, fromEnd, bytes) {
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const handle = openSync(file, "r");
  try {
    readSync(handle, buffer, 0, length, fromEnd ? size - length : 0);
  } finally {
    closeSync(handle);
  }
  return buffer.toString("utf8").split(/\r?\n/);
}

export function readAutoContinueConfig(root, env = process.env) {
  const config = { enabled: true, maxNudges: DEFAULT_MAX_NUDGES };
  if (env.ASTERWEAVE_NO_AUTOCONTINUE === "1") config.enabled = false;
  if (existsSync(join(root, ".claude", "asterweave", ".no-autocontinue"))) config.enabled = false;
  const settings = readJson(join(root, ".claude", "asterweave.json"))?.autoContinue;
  if (settings && typeof settings === "object") {
    if (settings.enabled === false) config.enabled = false;
    if (Number.isInteger(settings.maxNudges) && settings.maxNudges >= 1) config.maxNudges = settings.maxNudges;
  }
  return config;
}

// Session start = the first timestamp recorded in the transcript (fallback: its creation time).
export function sessionStart(transcriptPath) {
  if (typeof transcriptPath !== "string" || !existsSync(transcriptPath)) return null;
  try {
    for (const line of readSlice(transcriptPath, false, HEAD_BYTES)) {
      if (!line.includes('"timestamp"')) continue;
      try {
        const at = Date.parse(JSON.parse(line).timestamp);
        if (Number.isFinite(at)) return at;
      } catch {
        // A partial first-slice line; keep looking.
      }
    }
    return statSync(transcriptPath).birthtimeMs || null;
  } catch {
    return null;
  }
}

// The latest main-conversation assistant text, used to detect a deliberate question to the user.
export function lastAssistantText(transcriptPath) {
  if (typeof transcriptPath !== "string" || !existsSync(transcriptPath)) return null;
  let lines;
  try {
    lines = readSlice(transcriptPath, true, TAIL_BYTES);
  } catch {
    return null;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.includes('"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" || entry.isSidechain) continue;
    const content = entry.message?.content;
    const texts = Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text) : [];
    if (texts.length) return texts.join("\n").trim();
  }
  return null;
}

function endsWithQuestion(text) {
  return typeof text === "string" && /\?$/.test(text.replace(/[\s*_`)\]"'>]+$/, ""));
}

// Unfinished ledgers this session wrote. Approval checkpoints, blocked, paused, aborted, and
// completed runs are deliberate stopping points and never count.
export function openLedgers(root, since) {
  const base = join(root, ".claude", "asterweave");
  const candidates = [];
  const graph = join(base, "state.json");
  if (existsSync(graph)) candidates.push({ kind: "graph", path: graph });
  const completion = join(base, "completion");
  if (existsSync(completion)) {
    for (const entry of readdirSync(completion, { withFileTypes: true })) {
      const path = join(completion, entry.name, "state.json");
      if (entry.isDirectory() && existsSync(path)) candidates.push({ kind: "completion", path });
    }
  }

  const open = [];
  for (const candidate of candidates) {
    const stat = statSync(candidate.path);
    if (stat.mtimeMs < since) continue;
    const state = readJson(candidate.path);
    if (!state || state.status !== "active") continue;
    if (candidate.kind === "graph") {
      if (["done", "approve"].includes(state.currentNode)) continue;
      const node = state.nodes?.[state.currentNode];
      open.push({
        ...candidate,
        stat,
        summary: `workflow ${state.workflowId} is at node '${state.currentNode}' (attempt ${node?.attempts ?? 0}/${node?.maxAttempts ?? "?"})`,
      });
    } else {
      if (["awaiting-approval", "done"].includes(state.phase)) continue;
      open.push({ ...candidate, stat, summary: `completion run ${state.runId} is in phase '${state.phase}' (wave ${state.currentWave ?? 0})` });
    }
  }
  return open;
}

// Progress = any ledger write, a new commit, or a working-tree change since the last nudge.
function fingerprint(root, ledgers) {
  const hash = createHash("sha256");
  for (const ledger of [...ledgers].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${ledger.path}|${ledger.stat.mtimeMs}|${ledger.stat.size}\n`);
  }
  for (const args of [["rev-parse", "HEAD"], ["status", "--porcelain"], ["diff", "--stat"]]) {
    try {
      hash.update(execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      // Not a Git repository, or Git is unavailable; ledger timestamps still track progress.
    }
  }
  return hash.digest("hex");
}

function counterPath(directory, sessionId) {
  return join(directory, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown"}.json`);
}

export function evaluateStop(payload, cwd = process.cwd(), { env = process.env, stateDirectory = join(tmpdir(), "asterweave-autocontinue") } = {}) {
  const root = repositoryRoot(resolve(payload?.cwd || cwd));
  const config = readAutoContinueConfig(root, env);
  if (!config.enabled) return null;

  const transcript = payload?.transcript_path;
  const since = sessionStart(transcript);
  if (since === null) return null;

  const open = openLedgers(root, since);
  if (!open.length) return null;

  if (endsWithQuestion(lastAssistantText(transcript))) return null;

  const threshold = resolveThreshold(root, env);
  const tokens = threshold ? latestContextTokens(transcript) : null;
  if (threshold && tokens !== null && tokens >= threshold) return null;

  const counterFile = counterPath(stateDirectory, payload?.session_id || transcript);
  const counter = { nudges: 0, stalls: 0, fingerprint: "", ...(readJson(counterFile) ?? {}) };
  const current = fingerprint(root, open);
  counter.stalls = current === counter.fingerprint ? counter.stalls + 1 : 0;
  if (counter.nudges >= config.maxNudges || counter.stalls >= MAX_STALLS) return null;

  counter.nudges += 1;
  counter.fingerprint = current;
  try {
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(counterFile, `${JSON.stringify(counter)}\n`, { mode: 0o600 });
  } catch {
    // Without a persisted counter neither the cap nor stall detection can hold; let the stop through.
    return null;
  }

  return {
    decision: "block",
    reason: [
      `Asterweave auto-continue (${counter.nudges}/${config.maxNudges}): the run this session is driving is not finished.`,
      ...open.map((ledger) => `- ${ledger.summary}`),
      "Keep going from the ledger: continue the current node or wave, record environment evidence, and transition through the state script. Do not wait for a human \"continue\".",
      "Stop only for a real decision: ask it as a question (end your message with '?'), or record needs-human / pause so the run becomes blocked.",
    ].join("\n"),
    systemMessage: `Asterweave: auto-continuing the active run (${counter.nudges}/${config.maxNudges}).`,
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
    const output = evaluateStop(payload);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    // Fail open: auto-continue must never break a session.
  }
}
