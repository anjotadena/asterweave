#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export const NODE_ORDER = [
  "intake",
  "analyze",
  "challenge",
  "plan",
  "approve",
  "implement",
  "test",
  "verify",
  "review",
  "submit-pr",
  "monitor-pipeline",
  "resolve-review-comments",
  "update-work-item",
];

export const NODE_CONTRACTS = {
  intake: { maxAttempts: 2, evidence: ["task"] },
  analyze: { maxAttempts: 2, evidence: ["repository", "baseline"] },
  challenge: { maxAttempts: 2, evidence: ["requirements"] },
  plan: { maxAttempts: 2, evidence: ["plan"] },
  approve: { maxAttempts: 1, evidence: ["approval"] },
  implement: { maxAttempts: 3, evidence: ["change"] },
  test: { maxAttempts: 3, evidence: ["unit-test", "integration-test"] },
  verify: { maxAttempts: 2, evidence: ["acceptance"] },
  review: { maxAttempts: 2, evidence: ["code-review", "security-review"] },
  "submit-pr": { maxAttempts: 2, evidence: ["pull-request"] },
  "monitor-pipeline": { maxAttempts: 3, evidence: ["pipeline"] },
  "resolve-review-comments": { maxAttempts: 3, evidence: ["review-comments"] },
  "update-work-item": { maxAttempts: 2, evidence: ["work-item-update"] },
};

const OUTCOMES = new Set([
  "pass",
  "fail-retryable",
  "fail-replan",
  "blocked",
  "needs-human",
  "policy-denied",
  "security-escalation",
  "abort",
]);

function paths(cwd = process.cwd()) {
  const directory = resolve(cwd, ".claude", "asterweave");
  return {
    directory,
    state: resolve(directory, "state.json"),
    events: resolve(directory, "events.jsonl"),
  };
}

function now() {
  return new Date().toISOString();
}

function blankNode(name) {
  return {
    status: "pending",
    attempts: 0,
    maxAttempts: NODE_CONTRACTS[name].maxAttempts,
    startedAt: null,
    completedAt: null,
    outcome: null,
    evidence: [],
    failureSignatures: [],
  };
}

function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return { positional, options };
}

function atomicWrite(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(temporary, file);
  } catch (error) {
    if (existsSync(file)) {
      unlinkSync(file);
      renameSync(temporary, file);
    } else {
      throw error;
    }
  }
}

function appendEvent(file, event) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: now(), ...event })}\n`, { mode: 0o600 });
}

export function loadState(cwd = process.cwd()) {
  const target = paths(cwd).state;
  if (!existsSync(target)) {
    throw new Error("No active Asterweave state. Run graph-state.mjs init --goal \"...\" first.");
  }
  return JSON.parse(readFileSync(target, "utf8"));
}

function saveState(state, event, cwd = process.cwd()) {
  const target = paths(cwd);
  state.updatedAt = now();
  atomicWrite(target.state, state);
  appendEvent(target.events, { workflowId: state.workflowId, ...event });
  return state;
}

export function initialize({ goal, source = null, force = false, cwd = process.cwd() }) {
  if (!goal?.trim()) throw new Error("--goal is required");
  const target = paths(cwd);
  if (existsSync(target.state) && !force) {
    const existing = JSON.parse(readFileSync(target.state, "utf8"));
    if (!["completed", "aborted"].includes(existing.status)) {
      throw new Error(`Workflow ${existing.workflowId} is still ${existing.status}. Resume, abort, or pass --force.`);
    }
  }
  const timestamp = now();
  const state = {
    schemaVersion: 1,
    workflowId: randomUUID(),
    goal: goal.trim(),
    source,
    status: "active",
    currentNode: "intake",
    nodes: Object.fromEntries(NODE_ORDER.map((name) => [name, blankNode(name)])),
    stackProfile: null,
    approvals: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  mkdirSync(target.directory, { recursive: true });
  writeFileSync(target.events, "", { mode: 0o600 });
  return saveState(state, { type: "workflow.initialized", goal: state.goal, source }, cwd);
}

function assertNode(node) {
  if (!NODE_ORDER.includes(node)) throw new Error(`Unknown node: ${node}`);
}

function assertCanEnter(state, node) {
  assertNode(node);
  if (state.status !== "active") throw new Error(`Workflow is ${state.status}, not active.`);
  if (node !== state.currentNode) {
    throw new Error(`Cannot enter ${node}; current node is ${state.currentNode}.`);
  }
  if (["passed", "skipped"].includes(state.nodes[node].status)) {
    throw new Error(`${node} is already ${state.nodes[node].status}.`);
  }
}

export function enterNode(node, cwd = process.cwd()) {
  const state = loadState(cwd);
  assertCanEnter(state, node);
  const record = state.nodes[node];
  if (record.attempts >= record.maxAttempts) {
    state.status = "blocked";
    saveState(state, { type: "node.budget-exhausted", node }, cwd);
    throw new Error(`${node} exhausted its ${record.maxAttempts} attempts. Replan or request human direction.`);
  }
  record.status = "running";
  record.attempts += 1;
  record.startedAt = now();
  record.completedAt = null;
  return saveState(state, { type: "node.entered", node, attempt: record.attempts }, cwd);
}

export function addEvidence(node, evidence, cwd = process.cwd()) {
  const state = loadState(cwd);
  assertNode(node);
  if (!evidence.kind?.trim() || !evidence.summary?.trim()) {
    throw new Error("Evidence requires --kind and --summary.");
  }
  if (!new Set(["pass", "fail", "info"]).has(evidence.result)) {
    throw new Error("Evidence --result must be pass, fail, or info.");
  }
  const entry = {
    kind: evidence.kind.trim(),
    summary: evidence.summary.trim(),
    path: evidence.path || null,
    command: evidence.command || null,
    result: evidence.result,
    recordedAt: now(),
  };
  state.nodes[node].evidence.push(entry);
  return saveState(state, { type: "evidence.recorded", node, evidence: entry }, cwd);
}

function latestEvidence(state, node) {
  const latest = new Map();
  for (const item of state.nodes[node].evidence) latest.set(item.kind, item);
  return latest;
}

function missingEvidence(state, node) {
  const latest = latestEvidence(state, node);
  return NODE_CONTRACTS[node].evidence.filter((kind) => {
    const item = latest.get(kind);
    return !item || item.result === "fail";
  });
}

function nextNode(node) {
  const index = NODE_ORDER.indexOf(node);
  return index === NODE_ORDER.length - 1 ? "done" : NODE_ORDER[index + 1];
}

function routeFailure(node, outcome) {
  if (outcome === "fail-replan") return "plan";
  if (outcome === "security-escalation") return "review";
  if (["test", "verify", "review", "monitor-pipeline", "resolve-review-comments"].includes(node)) return "implement";
  return node;
}

function invalidateRange(state, fromNode, throughNode) {
  const start = NODE_ORDER.indexOf(fromNode);
  const end = NODE_ORDER.indexOf(throughNode);
  if (start < 0 || end < start) return;
  for (const name of NODE_ORDER.slice(start, end + 1)) {
    state.nodes[name].status = "pending";
    state.nodes[name].startedAt = null;
    state.nodes[name].completedAt = null;
    state.nodes[name].outcome = null;
  }
}

export function completeNode(node, outcome, options = {}, cwd = process.cwd()) {
  const state = loadState(cwd);
  assertNode(node);
  if (!OUTCOMES.has(outcome)) throw new Error(`Unsupported outcome: ${outcome}`);
  if (state.nodes[node].status !== "running") {
    throw new Error(`${node} must be running before it can complete.`);
  }
  const record = state.nodes[node];
  record.outcome = outcome;
  record.completedAt = now();

  if (outcome === "pass") {
    const missing = missingEvidence(state, node);
    if (missing.length > 0) {
      throw new Error(`${node} cannot pass; missing evidence kinds: ${missing.join(", ")}`);
    }
    const currentFailures = [...latestEvidence(state, node).values()].filter((item) => item.result === "fail");
    if (currentFailures.length > 0) {
      throw new Error(`${node} cannot pass while its latest evidence still contains failures.`);
    }
    record.status = "passed";
    state.currentNode = nextNode(node);
    if (state.currentNode === "done") state.status = "completed";
  } else if (outcome === "abort") {
    record.status = "failed";
    state.status = "aborted";
  } else if (["blocked", "needs-human", "policy-denied", "security-escalation"].includes(outcome)) {
    record.status = "blocked";
    state.status = "blocked";
  } else {
    record.status = "failed";
    if (options.signature) {
      record.failureSignatures.push(options.signature);
      const repeated = record.failureSignatures.filter((value) => value === options.signature).length;
      if (repeated >= 2) {
        state.status = "blocked";
        return saveState(
          state,
          { type: "node.stable-failure", node, outcome, signature: options.signature },
          cwd,
        );
      }
    }
    const destination = routeFailure(node, outcome);
    if (destination !== node) invalidateRange(state, destination, node);
    if (state.nodes[destination].attempts >= state.nodes[destination].maxAttempts) {
      state.status = "blocked";
    } else {
      state.currentNode = destination;
    }
  }
  return saveState(state, { type: "node.completed", node, outcome, currentNode: state.currentNode }, cwd);
}

export function approve({ by, summary }, cwd = process.cwd()) {
  const current = loadState(cwd);
  if (current.currentNode !== "approve") throw new Error(`Approval is not current; current node is ${current.currentNode}.`);
  if (!by?.trim() || !summary?.trim()) throw new Error("Approval requires --by and --summary.");
  if (current.nodes.approve.status !== "running") enterNode("approve", cwd);
  const state = loadState(cwd);
  state.approvals.push({ by: by.trim(), summary: summary.trim(), approvedAt: now() });
  saveState(state, { type: "approval.recorded", by: by.trim(), summary: summary.trim() }, cwd);
  addEvidence("approve", { kind: "approval", summary: `${by.trim()}: ${summary.trim()}`, result: "pass" }, cwd);
  return completeNode("approve", "pass", {}, cwd);
}

export function resume(cwd = process.cwd()) {
  const state = loadState(cwd);
  if (state.status !== "blocked") throw new Error(`Workflow is ${state.status}; only blocked workflows can resume.`);
  state.status = "active";
  const record = state.nodes[state.currentNode];
  if (record?.status === "blocked") record.status = "pending";
  return saveState(state, { type: "workflow.resumed", currentNode: state.currentNode }, cwd);
}

export function pause(reason, cwd = process.cwd()) {
  const state = loadState(cwd);
  if (state.status !== "active") throw new Error(`Workflow is already ${state.status}.`);
  state.status = "blocked";
  return saveState(state, { type: "workflow.paused", reason: reason || "Paused by user" }, cwd);
}

export function validateState(state) {
  const errors = [];
  for (const node of NODE_ORDER) {
    if (!state.nodes[node]) errors.push(`Missing node: ${node}`);
  }
  if (state.status === "completed") {
    for (const node of NODE_ORDER) {
      if (state.nodes[node]?.status !== "passed") errors.push(`${node} is not passed`);
      const missing = state.nodes[node] ? missingEvidence(state, node) : [];
      if (missing.length) errors.push(`${node} missing ${missing.join(", ")}`);
    }
  }
  return errors;
}

function printState(state, compact = false) {
  if (compact) {
    const nodes = Object.fromEntries(
      NODE_ORDER.map((node) => [node, { status: state.nodes[node].status, attempts: state.nodes[node].attempts }]),
    );
    console.log(JSON.stringify({ workflowId: state.workflowId, goal: state.goal, status: state.status, currentNode: state.currentNode, nodes }, null, 2));
  } else {
    console.log(JSON.stringify(state, null, 2));
  }
}

function usage() {
  console.error(`Usage:
  graph-state.mjs init --goal <text> [--source <ref>] [--force]
  graph-state.mjs enter <node>
  graph-state.mjs evidence <node> --kind <kind> --summary <text> --result <pass|fail|info> [--path <path>] [--command <command>]
  graph-state.mjs complete <node> <outcome> [--signature <stable-failure-id>]
  graph-state.mjs approve --by <identity> --summary <text>
  graph-state.mjs pause [--reason <text>]
  graph-state.mjs resume
  graph-state.mjs status [--compact]
  graph-state.mjs validate`);
}

export function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  const [command, ...rest] = argv;
  const { positional, options } = parseOptions(rest);
  let state;
  switch (command) {
    case "init":
      state = initialize({ goal: options.goal, source: options.source || null, force: Boolean(options.force), cwd });
      break;
    case "enter":
      state = enterNode(positional[0], cwd);
      break;
    case "evidence":
      state = addEvidence(positional[0], {
        kind: options.kind,
        summary: options.summary,
        result: options.result || "info",
        path: options.path,
        command: options.command,
      }, cwd);
      break;
    case "complete":
      state = completeNode(positional[0], positional[1], { signature: options.signature }, cwd);
      break;
    case "approve":
      state = approve({ by: options.by, summary: options.summary }, cwd);
      break;
    case "pause":
      state = pause(options.reason, cwd);
      break;
    case "resume":
      state = resume(cwd);
      break;
    case "status":
      state = loadState(cwd);
      break;
    case "validate": {
      state = loadState(cwd);
      const errors = validateState(state);
      if (errors.length) throw new Error(errors.join("; "));
      break;
    }
    default:
      usage();
      return 2;
  }
  printState(state, Boolean(options.compact));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(`Asterweave state error: ${error.message}`);
    process.exitCode = 1;
  }
}
