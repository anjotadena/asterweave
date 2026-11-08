// `asterweave run show|approve|abort` and the hidden `run start|resume`, in-process through runCli with real git
// repositories, a real ledger in a temp user directory and (for the prompts) a fake terminal.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { helpText, runCli, usageText } from "../src/cli.mjs";
import { resolveRepo } from "../src/commands/run.mjs";
import { MAX_FAILED_ATTEMPTS, invalidateApproval, requestApproval } from "../src/runtime/approvals.mjs";
import { createFakeExecutor, loadScript } from "../src/runtime/fake-executor.mjs";
import { loadRun, runDir } from "../src/runtime/ledger.mjs";
import { commitRecords, createRunForGraph, runLoop } from "../src/runtime/loop.mjs";
import { acquireRunLock, inspectRunLock } from "../src/runtime/lock.mjs";
import { attempt, deliveryGraph, grantPending, readEvents, script, tool } from "./loop-fixture.mjs";
import { cleanupTemp, fakeTerminal, git, tempDir, waitFor } from "./repo-fixture.mjs";

after(cleanupTemp);

// --- harness -------------------------------------------------------------------------------------

const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};

function cliEnv(userDir, extra = {}) {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ASTERWEAVE_CONFIG_DIR: userDir, ...extra };
}

let sharedRepo;
/** One small real git repository shared by the file (nothing here writes into it). */
function repoDir() {
  if (sharedRepo) return sharedRepo;
  sharedRepo = tempDir("aw-rc-repo-");
  git(sharedRepo, "init", "-b", "main");
  writeFileSync(join(sharedRepo, "README.md"), "hello\n");
  git(sharedRepo, "add", "README.md");
  git(sharedRepo, "commit", "-m", "initial");
  mkdirSync(join(sharedRepo, "sub"), { recursive: true });
  return sharedRepo;
}

async function cli(argv, { env, cwd = repoDir(), ...extra }) {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(argv, { stdout, stderr, stdin: extra.stdin ?? sink(), env, cwd, ...extra });
  return { code, out: stdout.text(), err: stderr.text() };
}

const json = (result) => JSON.parse(result.out);

/** A run for the shared repository, driven in-process to wherever the script first stops. */
async function fixture({ goal = "ship the feature", runId = "run-1", plan, graph = deliveryGraph, extraEnv = {} } = {}) {
  const userDir = tempDir("aw-rc-user-");
  const env = cliEnv(userDir, extraEnv);
  const identity = await resolveRepo({ cwd: repoDir(), env });
  const { dir } = createRunForGraph({ graph, goal, repo: { key: identity.key, realpath: identity.workspace }, runId, env });
  const steps = script(graph, plan);
  const nonces = new Map(); // what a supervising terminal would have shown: approval id -> plaintext nonce
  const result = await runLoop({ dir, graph, executor: createFakeExecutor(steps), sleep: async () => {}, workspaceRoot: identity.workspace, guardOptions: { env, userDir }, onApprovalNonce: ({ approvalId, nonce }) => nonces.set(approvalId, nonce) });
  return { userDir, env, dir, graph, identity, steps, result, runId, nonces };
}

/** Every byte under a directory, as one string (to prove a secret was never written anywhere). */
function treeText(dir) {
  const parts = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    parts.push(statSync(file).isDirectory() ? treeText(file) : readFileSync(file, "latin1"));
  }
  return parts.join("\n");
}

const box = { now: () => new Date().toISOString() };

/** Put an approval request straight into the ledger (what a legacy or edited run.json could hold; the loop refuses some of these). */
function seedApproval(fx, scope, requestedBy = "executor") {
  const lock = acquireRunLock(fx.dir);
  try {
    const { run } = loadRun(fx.dir);
    const result = requestApproval(run, { kind: "operation", scope, now: new Date().toISOString(), requestedBy });
    commitRecords({ dir: fx.dir, graph: fx.graph, lockToken: lock.token }, run, result.events);
    fx.nonces.set(result.approval.id, result.nonce);
    return result.approval;
  } finally {
    lock.release();
  }
}
const planApproval = (fx) => fx.result.pendingApprovals[0];
const approveArgs = (fx, approval = planApproval(fx), subject = approval.subjectHash.slice(0, 12), nonce = fx.nonces.get(approval.id)) => ["run", "approve", fx.runId, "--approval", approval.id, "--subject", subject, "--nonce", nonce];
const BIDI = [0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const CONTROL = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${BIDI.map((code) => String.fromCharCode(code)).join("")}]`);

// --- repository identity ---------------------------------------------------------------------------

test("the repository key is the realpath of the git common dir (lower-cased on win32) and is the same from a subdirectory", async () => {
  const env = cliEnv(tempDir("aw-rc-user-"));
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoDir(), encoding: "utf8" }).trim();
  const expected = realpathSync.native(common);
  const root = await resolveRepo({ cwd: repoDir(), env });
  const sub = await resolveRepo({ cwd: join(repoDir(), "sub"), env });
  assert.equal(root.key, process.platform === "win32" ? expected.toLowerCase() : expected);
  assert.equal(sub.key, root.key);
  assert.equal(root.workspace, realpathSync.native(repoDir()));
  assert.equal(sub.workspace, root.workspace, "the workspace is the work tree root, not the subdirectory");
  assert.equal(root.git, true);
});

test("outside a git repository the key falls back to the realpath of the directory", async () => {
  const plain = tempDir("aw-rc-plain-");
  const env = cliEnv(tempDir("aw-rc-user-"));
  const identity = await resolveRepo({ cwd: plain, env });
  assert.equal(identity.git, false);
  assert.equal(identity.workspace, plain);
  assert.equal(identity.key, process.platform === "win32" ? plain.toLowerCase() : plain);
});

// --- run show ---------------------------------------------------------------------------------------

test("run show --json has a stable shape; tokens are unavailable, never 0; the lock and policy are reported", async () => {
  const fx = await fixture();
  assert.equal(fx.result.status, "waiting-approval");
  const result = await cli(["run", "show", "--json"], fx);
  assert.equal(result.code, 0);
  const { ok, run } = json(result);
  assert.equal(ok, true);
  assert.deepEqual(Object.keys(run), ["runId", "graph", "goal", "status", "currentNode", "repo", "createdAt", "updatedAt", "lastSeq", "eventsBehind", "nodes", "approvals", "budgets", "lock", "policy", "attention"]);
  assert.equal(run.runId, "run-1");
  assert.deepEqual([run.graph.id, run.graph.version, run.graph.hash.length], ["delivery", 1, 12]);
  assert.equal(run.status, "waiting-approval");
  assert.equal(run.currentNode, "approve");
  assert.equal(run.repo.realpath, fx.identity.workspace);
  assert.deepEqual(Object.keys(run.nodes[0]), ["id", "status", "attempts", "maxAttempts", "outcome"]);
  assert.deepEqual(run.nodes.map((node) => node.id).slice(0, 3), ["intake", "analyze", "challenge"]);
  assert.deepEqual(run.nodes.find((node) => node.id === "plan"), { id: "plan", status: "passed", attempts: 1, maxAttempts: 2, outcome: "pass" });
  assert.equal(run.eventsBehind, 0);
  assert.equal(run.lastSeq, readEvents(fx.dir).length);

  assert.equal(run.approvals.length, 1);
  const [approval] = run.approvals;
  assert.deepEqual(Object.keys(approval), ["id", "kind", "scope", "targetLength", "displayable", "state", "valid", "subject", "requestedBy", "by", "requestedAt", "grantedAt", "invalidatedAt"]);
  assert.deepEqual([approval.requestedBy, approval.displayable, approval.targetLength], ["guard", true, "approve".length]);
  assert.equal(approval.state, "pending");
  assert.equal(approval.subject, planApproval(fx).subjectHash.slice(0, 12));
  assert.equal(approval.subject.length, 12);

  assert.deepEqual(run.budgets.tokens, { used: null, limit: null, available: false });
  assert.deepEqual(Object.keys(run.budgets), ["iterations", "toolCalls", "tokens", "wallMs"]);
  assert.equal(run.budgets.toolCalls.limit, 200);
  assert.equal(run.lock.state, "none");
  assert.equal(run.policy.mode, "supervised");
  assert.equal(run.policy.changed, false);
  assert.equal(run.policy.hash.length, 12);
  assert.deepEqual([run.attention.decision, run.attention.node], ["require-approval", "approve"], "the pending plan approval is the reason the run is stopped");
  // Identical output for identical state.
  assert.equal((await cli(["run", "show", "--json"], fx)).out, result.out);
});

test("run show text lists nodes, approvals with the subject prefix, budgets and the approve command", async () => {
  const fx = await fixture();
  const { code, out, err } = await cli(["run", "show", "run-1"], fx);
  assert.equal(code, 0);
  assert.equal(err, "");
  const subject = planApproval(fx).subjectHash.slice(0, 12);
  assert.match(out, /^Run {7}run-1$/m);
  assert.match(out, /^Graph {5}delivery@1 \(/m);
  assert.match(out, /^Status {4}waiting-approval \(at approve\)$/m);
  assert.match(out, /^ {2}plan {2,}passed {2,}1\/2/m);
  assert.match(out, new RegExp(`ap-1 {2}pending {2}plan plan`));
  assert.match(out, new RegExp(`subject ${subject}`));
  assert.match(out, /^ {2}tokens {6}unavailable$/m);
  assert.ok(!/tokens\s+0\b/.test(out), "tokens are never rendered as 0");
  assert.match(out, /^ {2}asterweave run approve run-1$/m, "the terminal command comes first");
  assert.match(out, new RegExp(`asterweave run approve run-1 --approval ap-1 --subject ${subject} --nonce <nonce>`));
  assert.ok(!out.includes(planApproval(fx).nonceHash), "the nonce hash is not shown either");
  assert.equal(CONTROL.test(out.replaceAll("\n", "")), false);
});

test("run show picks the newest run of the repository, a named run, and refuses unknown or invalid ids", async () => {
  const fx = await fixture({ runId: "older" });
  const later = createRunForGraph({ graph: deliveryGraph, goal: "newer goal", repo: { key: fx.identity.key, realpath: fx.identity.workspace }, runId: "newer", env: fx.env, now: () => new Date(Date.now() + 5000).toISOString() });
  assert.ok(later.dir);
  assert.equal(json(await cli(["run", "show", "--json"], fx)).run.runId, "newer");
  assert.equal(json(await cli(["run", "show", "older", "--json"], fx)).run.runId, "older");
  const missing = await cli(["run", "show", "nope", "--json"], fx);
  assert.equal(missing.code, 1);
  assert.equal(json(missing).error.code, "RUN_NOT_FOUND");
  const invalid = await cli(["run", "show", "../escape", "--json"], fx);
  assert.equal(invalid.code, 2);
  assert.equal(json(invalid).error.code, "RUN_ID_INVALID");
  // The same user directory seen from another repository has no runs.
  const other = tempDir("aw-rc-other-");
  git(other, "init", "-b", "main");
  const none = await cli(["run", "show", "--json"], { ...fx, cwd: other });
  assert.equal(none.code, 1);
  assert.equal(json(none).error.code, "RUN_NOT_FOUND");
  assert.equal((await cli(["run", "show", "older", "extra"], fx)).code, 2);
});

test("run show sanitises hostile text in the goal and in approval targets; no raw control bytes reach the output", async () => {
  const hostileGoal = "fix \x1b[2J\x1b]0;pwned\x07the \x1b[31mbug\x1b[0m " + String.fromCharCode(0x202e) + "evil" + String.fromCharCode(0x9b) + " end";
  const hostileTarget = "\x1b]52;c;ZXZpbA==\x07rm \x1b[31m-rf\x1b[0m \u009b31m";
  // The loop itself refuses to REQUEST such an approval (UNDISPLAYABLE_TARGET), so the hostile request is seeded
  // straight into the ledger, the way an edited or legacy run.json would hold it.
  const fx = await fixture({ goal: hostileGoal });
  assert.equal(fx.result.status, "waiting-approval");
  seedApproval(fx, { operation: "deploy", target: hostileTarget });
  const text = await cli(["run", "show"], fx);
  assert.equal(text.code, 0);
  assert.equal(CONTROL.test(text.out.replaceAll("\n", "")), false, JSON.stringify(text.out));
  assert.ok(text.out.includes("bug"));
  assert.ok(text.out.includes("deploy"));
  const asJson = await cli(["run", "show", "--json"], fx);
  assert.equal(CONTROL.test(asJson.out.replaceAll("\n", "")), false, "stringifyJson escapes control characters");
  assert.equal(asJson.out.trimEnd().split("\n").length, 1, "exactly one JSON line");
  const seeded = json(asJson).run.approvals.find((entry) => entry.scope.operation === "deploy");
  assert.equal(seeded.displayable, false, "flagged as not faithful");
  assert.ok(text.out.includes("NOT FAITHFUL"));
  assert.ok(!text.out.includes(`--approval ${seeded.id}`), "no approve command is suggested for it");
});

test("run show reports the stop reason of a denied run (attention) and a held lock", async () => {
  const destructive = ["git", "reset", "--hard"].join(" ");
  const fx = await fixture({ plan: { intake: [{ node: "intake", action: tool("shell", { command: destructive }) }] } });
  assert.equal(fx.result.exitCode, 7);
  const { run } = json(await cli(["run", "show", "--json"], fx));
  assert.equal(run.status, "blocked");
  assert.equal(run.attention.reason, "DESTRUCTIVE_COMMAND");
  assert.equal(run.attention.decision, "deny");
  assert.equal(run.nodes.find((node) => node.id === "intake").outcome, "policy-denied");
  const lock = acquireRunLock(fx.dir);
  try {
    const held = json(await cli(["run", "show", "--json"], fx)).run.lock;
    assert.equal(held.state, "live");
    assert.equal(held.pid, process.pid);
  } finally {
    lock.release();
  }
});

// --- run approve (flags) ------------------------------------------------------------------------------

test("run approve with --approval and --subject records a flag approval, takes and releases the lock", async () => {
  const fx = await fixture();
  const approval = planApproval(fx);
  const result = await cli([...approveArgs(fx), "--json"], fx);
  assert.equal(result.code, 0, result.err + result.out);
  const body = json(result);
  assert.equal(body.ok, true);
  assert.equal(body.approved[0].id, approval.id);
  assert.equal(body.approved[0].by.source, "flag");
  assert.equal(body.approved[0].state, "granted");
  const stored = loadRun(fx.dir).run;
  assert.notEqual(stored.approvals[0].grantedAt, null);
  assert.equal(stored.approvals[0].by.source, "flag");
  assert.equal(stored.approvals[0].nonceHash, null, "the nonce is consumed");
  assert.equal(stored.status, "waiting-approval", "approving records the grant; the run continues only when it is driven again");
  assert.equal(inspectRunLock(fx.dir).state, "none");
  const events = readEvents(fx.dir);
  assert.equal(events.at(-1).type, "approval.granted");
  assert.equal(events.at(-1).approvalId, approval.id);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  // Text form.
  const again = await cli(approveArgs(fx), fx);
  assert.equal(again.code, 1, "already granted");
  const fresh = await fixture({ runId: "run-2" });
  const text = await cli(approveArgs(fresh), fresh);
  assert.equal(text.code, 0);
  assert.match(text.out, /^Approved ap-1 \(plan plan\) for run run-2\.$/m);
});

test("run approve: a wrong, too short or missing subject grants nothing", async () => {
  const fx = await fixture();
  const approval = planApproval(fx);
  const before = readEvents(fx.dir).length;
  const wrong = await cli(approveArgs(fx, approval, "ffffffffffff"), { ...fx });
  assert.equal(wrong.code, 2);
  const short = await cli([...approveArgs(fx, approval, approval.subjectHash.slice(0, 5)), "--json"], fx);
  assert.equal(short.code, 2);
  assert.equal(json(short).error.code, "APPROVAL_SUBJECT_MISMATCH");
  const noSubject = await cli(["run", "approve", fx.runId, "--approval", approval.id], fx);
  assert.equal(noSubject.code, 2);
  const noApproval = await cli(["run", "approve", fx.runId, "--subject", approval.subjectHash.slice(0, 12)], fx);
  assert.equal(noApproval.code, 2);
  const neither = await cli(["run", "approve", fx.runId], fx);
  assert.equal(neither.code, 2, "non-TTY needs the flags");
  assert.equal((await cli(["run", "approve"], fx)).code, 2);
  assert.equal(readEvents(fx.dir).length, before, "nothing was written");
  assert.equal(loadRun(fx.dir).run.approvals[0].grantedAt, null);
  assert.equal(inspectRunLock(fx.dir).state, "none");
});

test("run approve: unknown run, unknown approval, a live lock and ASTERWEAVE_RUN_ID are refused", async () => {
  const fx = await fixture();
  const approval = planApproval(fx);
  const missingRun = await cli(["run", "approve", "ghost", "--approval", "ap-1", "--subject", "abcdef12", "--nonce", fx.nonces.get("ap-1"), "--json"], fx);
  assert.equal(missingRun.code, 1);
  assert.equal(json(missingRun).error.code, "RUN_NOT_FOUND");
  const missingApproval = await cli(["run", "approve", fx.runId, "--approval", "ap-99", "--subject", "abcdef12", "--nonce", fx.nonces.get("ap-1"), "--json"], fx);
  assert.equal(missingApproval.code, 1);
  assert.equal(json(missingApproval).error.code, "APPROVAL_NOT_FOUND");

  const lock = acquireRunLock(fx.dir);
  try {
    const locked = await cli([...approveArgs(fx), "--json"], fx);
    assert.equal(locked.code, 1);
    assert.equal(json(locked).error.code, "RUN_LOCKED");
  } finally {
    lock.release();
  }

  const inside = await cli([...approveArgs(fx), "--json"], { ...fx, env: { ...fx.env, ASTERWEAVE_RUN_ID: "run-1" } });
  assert.equal(inside.code, 7);
  assert.equal(json(inside).error.code, "APPROVAL_FORBIDDEN_CONTEXT");
  assert.equal(loadRun(fx.dir).run.approvals[0].grantedAt, null);
  assert.equal(approval.id, "ap-1");
});

test("run approve catches up a snapshot that is behind the log, and repairs a torn tail, under the lock", async () => {
  const fx = await fixture();
  const eventsFile = join(fx.dir, "events.jsonl");
  const before = readEvents(fx.dir).length;
  // A torn final line (an interrupted append).
  writeFileSync(eventsFile, '{"v":1,"seq":', { flag: "a" });
  const result = await cli([...approveArgs(fx), "--json"], fx);
  assert.equal(result.code, 0, result.err + result.out);
  const events = readEvents(fx.dir);
  assert.ok(events.some((event) => event.type === "ledger.repaired"));
  assert.equal(events.at(-1).type, "approval.granted");
  assert.ok(events.length > before);
  assert.equal(loadRun(fx.dir).behind, 0);
});

// --- run approve (terminal) ---------------------------------------------------------------------------

async function inTty(argv, answer, fx, { during } = {}) {
  const term = fakeTerminal();
  const running = runCli(argv, { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: fx.env, cwd: repoDir(), proc: new EventEmitter() });
  await waitFor(() => /\[y\/N\]/.test(term.text()), { label: "the confirmation prompt" });
  if (during) await during();
  term.stdin.write(answer);
  return { code: await running, term };
}

test("run approve in a terminal asks y/N naming scope, target and subject; only 'y' grants (source tty)", async () => {
  const fx = await fixture({ plan: { implement: attempt(deliveryGraph, "implement", { before: [tool("merge", { branch: "feat/x", into: "main" })] }) } });
  grantPending(box, fx.dir, fx.graph);
  const second = await runLoopAgain(fx);
  assert.equal(second.status, "waiting-approval");
  const merge = second.pendingApprovals[0];
  assert.equal(merge.scope.operation, "merge");

  const yes = await inTty(["run", "approve", fx.runId], "y", fx);
  assert.equal(yes.code, 0);
  const prompt = yes.term.text();
  assert.match(prompt, /Approve ap-2 for run run-1\?/);
  assert.ok(prompt.includes("merge"));
  assert.ok(prompt.includes("feat/x"), "the target is named");
  assert.ok(prompt.includes(merge.subjectHash.slice(0, 12)));
  assert.match(prompt, /\[y\/N\]/);
  const stored = loadRun(fx.dir).run.approvals.find((entry) => entry.id === "ap-2");
  assert.equal(stored.by.source, "tty");
  assert.notEqual(stored.grantedAt, null);
  assert.equal(inspectRunLock(fx.dir).state, "none");
});

async function runLoopAgain(fx) {
  return runLoop({ dir: fx.dir, graph: fx.graph, executor: createFakeExecutor(fx.steps), sleep: async () => {}, workspaceRoot: fx.identity.workspace, guardOptions: { env: fx.env, userDir: fx.userDir }, onApprovalNonce: ({ approvalId, nonce }) => fx.nonces.set(approvalId, nonce) });
}

test("run approve prompt: Enter, n, Esc and Ctrl+D grant nothing (exit 1), Ctrl+C is 130", async () => {
  for (const [answer, expected] of [["\r", 1], ["n", 1], ["\x1b", 1], ["\x04", 1], ["\x03", 130]]) {
    const fx = await fixture();
    const { code, term } = await inTty(["run", "approve", fx.runId], answer, fx);
    assert.equal(code, expected, JSON.stringify(answer));
    assert.deepEqual(term.stdin.rawCalls.at(-1), false, "raw mode restored");
    assert.equal(loadRun(fx.dir).run.approvals[0].grantedAt, null);
    assert.equal(inspectRunLock(fx.dir).state, "none");
  }
});

test("run approve prompt: the grant is bound to what was shown", async () => {
  const fx = await fixture();
  const { code, term } = await inTty(["run", "approve", fx.runId], "y", fx, {
    during: () => grantPending(box, fx.dir, fx.graph), // someone else decides while the prompt is open
  });
  assert.equal(code, 1);
  assert.match(term.errText(), /changed while you were deciding/);
  const approvals = loadRun(fx.dir).run.approvals;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].by.name, "tester", "only the other decision was recorded");
});

test("run approve in a terminal: --approval needs --subject, --json needs the flags, nothing waiting is an error", async () => {
  const fx = await fixture();
  const term = fakeTerminal();
  const proc = new EventEmitter();
  const common = { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: fx.env, cwd: repoDir(), proc };
  assert.equal(await runCli(["run", "approve", fx.runId, "--approval", "ap-1"], common), 2);
  assert.equal(await runCli(["run", "approve", fx.runId, "--json"], common), 2);
  assert.equal(JSON.parse(term.text().trim().split("\n").at(-1)).error.code, "APPROVAL_TERMINAL_REQUIRED");
  grantPending(box, fx.dir, fx.graph);
  const idle = fakeTerminal();
  const code = await runCli(["run", "approve", fx.runId], { ...common, stdin: idle.stdin, stdout: idle.stdout, stderr: idle.stderr });
  assert.equal(code, 1);
  assert.match(idle.errText(), /no approval waiting/);
});

// --- run abort ------------------------------------------------------------------------------------------

test("run abort needs --yes outside a terminal; it is idempotent and releases the lock", async () => {
  const fx = await fixture();
  assert.equal((await cli(["run", "abort", fx.runId], fx)).code, 2);
  assert.equal((await cli(["run", "abort", fx.runId, "--json"], fx)).code, 2);
  assert.equal(loadRun(fx.dir).run.status, "waiting-approval");

  const first = await cli(["run", "abort", fx.runId, "--yes", "--json"], fx);
  assert.equal(first.code, 0, first.err + first.out);
  assert.deepEqual(json(first), { ok: true, runId: "run-1", status: "aborted", alreadyAborted: false });
  const stored = loadRun(fx.dir).run;
  assert.equal(stored.status, "aborted");
  const events = readEvents(fx.dir);
  assert.ok(events.some((event) => event.type === "run.aborted"));
  assert.equal(inspectRunLock(fx.dir).state, "none");

  const count = events.length;
  const second = await cli(["run", "abort", fx.runId, "--yes", "--json"], fx);
  assert.equal(second.code, 0);
  assert.equal(json(second).alreadyAborted, true);
  const text = await cli(["run", "abort", fx.runId, "--yes"], fx);
  assert.match(text.out, /was already aborted/);
  assert.equal(readEvents(fx.dir).length, count, "an aborted run is not written to again");
  assert.equal(exitOfShow(await cli(["run", "show", "--json"], fx)), "aborted");
});

const exitOfShow = (result) => json(result).run.status;

test("run abort: unknown run is exit 1, a completed run cannot be aborted, a live lock is RUN_LOCKED", async () => {
  const fx = await fixture();
  const missing = await cli(["run", "abort", "ghost", "--yes", "--json"], fx);
  assert.equal(missing.code, 1);
  assert.equal(json(missing).error.code, "RUN_NOT_FOUND");

  const lock = acquireRunLock(fx.dir);
  try {
    const locked = await cli(["run", "abort", fx.runId, "--yes", "--json"], fx);
    assert.equal(locked.code, 1);
    assert.equal(json(locked).error.code, "RUN_LOCKED");
  } finally {
    lock.release();
  }
  assert.equal(loadRun(fx.dir).run.status, "waiting-approval");

  // Drive it to completion, then try to abort.
  grantPending(box, fx.dir, fx.graph);
  const finished = await runLoopAgain(fx);
  assert.equal(finished.status, "completed");
  const done = await cli(["run", "abort", fx.runId, "--yes", "--json"], fx);
  assert.equal(done.code, 1);
  assert.equal(json(done).error.code, "RUN_NOT_ACTIVE");
});

test("run abort in a terminal asks y/N (default No) and Ctrl+C is 130", async () => {
  for (const [answer, expected, status] of [["y", 0, "aborted"], ["\r", 1, "waiting-approval"], ["n", 1, "waiting-approval"], ["\x1b", 1, "waiting-approval"], ["\x03", 130, "waiting-approval"]]) {
    const fx = await fixture();
    const { code, term } = await inTty(["run", "abort", fx.runId], answer, fx);
    assert.equal(code, expected, JSON.stringify(answer));
    assert.match(term.text(), /Abort run run-1 \(waiting-approval, at approve\)\?/);
    assert.equal(loadRun(fx.dir).run.status, status);
    assert.equal(inspectRunLock(fx.dir).state, "none");
  }
});

// --- hidden start / resume ------------------------------------------------------------------------------

function writeScript(dir, steps) {
  const file = join(dir, "script.json");
  writeFileSync(file, JSON.stringify(steps));
  return file;
}

test("run start and run resume are refused without ASTERWEAVE_DEV_EXECUTORS=1 (exit 2, 'not available', no run created)", async () => {
  const userDir = tempDir("aw-rc-user-");
  const file = writeScript(userDir, script(deliveryGraph));
  for (const extra of [{}, { ASTERWEAVE_DEV_EXECUTORS: "0" }, { ASTERWEAVE_DEV_EXECUTORS: "true" }, { ASTERWEAVE_DEV_EXECUTORS: "" }]) {
    const env = cliEnv(userDir, extra);
    for (const argv of [["run", "start", "--executor", "fake", "--script", file], ["run", "resume", "run-1", "--executor", "fake", "--script", file, "--json"]]) {
      const result = await cli(argv, { env });
      assert.equal(result.code, 2, JSON.stringify(extra));
      assert.match(result.err + result.out, /not available/);
      assert.ok(!/executor|script|fake|dev/i.test((result.err + result.out).replace(/not available/g, "")), "no hint about the hidden feature");
    }
  }
  assert.equal(existsSync(join(userDir, "runs")), false, "nothing was created");
});

test("run start with the fake executor: one JSON object, exit 6 at the plan approval, then run show finds it", async () => {
  const userDir = tempDir("aw-rc-user-");
  const env = cliEnv(userDir, { ASTERWEAVE_DEV_EXECUTORS: "1" });
  const file = writeScript(userDir, script(deliveryGraph));
  const started = await cli(["run", "start", "--executor", "fake", "--script", file, "--goal", "dev goal", "--run-id", "dev-1", "--json"], { env });
  assert.equal(started.code, 6, started.err + started.out);
  const body = json(started);
  assert.equal(started.out.trimEnd().split("\n").length, 1);
  assert.deepEqual([body.ok, body.runId, body.graph, body.status, body.currentNode, body.exitCode], [false, "dev-1", "delivery@1", "waiting-approval", "approve", 6]);
  assert.equal(body.pendingApprovals.length, 1);
  assert.equal(body.pendingApprovals[0].subject.length, 12);

  const shown = json(await cli(["run", "show", "--json"], { env })).run;
  assert.equal(shown.runId, "dev-1");
  assert.equal(shown.goal, "dev goal");
  assert.equal(shown.approvals[0].subject, body.pendingApprovals[0].subject);

  // A headless supervisor printed no nonce, so flags cannot approve; the terminal prompt can.
  assert.equal(started.err, "", "nothing is printed on stderr, and no nonce exists anywhere");
  const forged = await cli(["run", "approve", "dev-1", "--approval", body.pendingApprovals[0].id, "--subject", body.pendingApprovals[0].subject, "--json"], { env });
  assert.equal(forged.code, 2);
  assert.equal(json(forged).error.code, "APPROVAL_TERMINAL_REQUIRED");
  const guess = await cli(["run", "approve", "dev-1", "--approval", body.pendingApprovals[0].id, "--subject", body.pendingApprovals[0].subject, "--nonce", "00000000-00000000-00000000-00000000", "--json"], { env });
  assert.equal(guess.code, 2, "no nonce was ever issued, so even a quoted one is not a flag grant: terminal only");
  assert.equal(json(guess).error.code, "APPROVAL_TERMINAL_REQUIRED");
  const approved = await inTty(["run", "approve", "dev-1"], "y", { env });
  assert.equal(approved.code, 0);
  const resumed = await cli(["run", "resume", "dev-1", "--executor", "fake", "--script", file, "--json"], { env });
  assert.equal(resumed.code, 0, resumed.err + resumed.out);
  assert.deepEqual([json(resumed).ok, json(resumed).status], [true, "completed"]);
  assert.equal(inspectRunLock(runDir((await resolveRepo({ cwd: repoDir(), env })).key, "dev-1", { env })).state, "none");
});

test("run start validates its input before creating anything", async () => {
  const userDir = tempDir("aw-rc-user-");
  const env = cliEnv(userDir, { ASTERWEAVE_DEV_EXECUTORS: "1" });
  const file = writeScript(userDir, script(deliveryGraph));
  const bad = writeScript(tempDir("aw-rc-bad-"), { v: 1, steps: [{ node: "intake" }] });
  for (const argv of [
    ["run", "start"],
    ["run", "start", "--executor", "model", "--script", file],
    ["run", "start", "--executor", "fake", "--script", join(userDir, "missing.json")],
    ["run", "start", "--executor", "fake", "--script", bad],
    ["run", "start", "--executor", "fake", "--script", file, "--graph", "nope@1"],
    ["run", "start", "--executor", "fake", "--script", file, "--run-id", "../x"],
    ["run", "start", "--executor", "fake", "--script", file, "stray"],
    ["run", "start", "--executor", "fake", "--script", file, "--approval", "ap-1"],
  ]) {
    assert.equal((await cli(argv, { env })).code, 2, argv.join(" "));
  }
  // An invalid policy is a configuration error and leaves no orphan run behind.
  writeFileSync(join(userDir, "policy.json"), "{ not json");
  const policy = await cli(["run", "start", "--executor", "fake", "--script", file, "--run-id", "p-1", "--json"], { env });
  assert.equal(policy.code, 5);
  assert.equal(json(policy).error.code, "POLICY_INVALID");
  assert.equal(existsSync(join(userDir, "runs")), false);
});

test("an aborted signal pauses a started run: exit 130, paused, lock released", async () => {
  const userDir = tempDir("aw-rc-user-");
  const env = cliEnv(userDir, { ASTERWEAVE_DEV_EXECUTORS: "1" });
  const file = writeScript(userDir, script(deliveryGraph));
  const result = await cli(["run", "start", "--executor", "fake", "--script", file, "--run-id", "sig-1", "--json"], { env, signal: AbortSignal.abort() });
  assert.equal(result.code, 130);
  assert.equal(json(result).status, "paused");
  const dir = runDir((await resolveRepo({ cwd: repoDir(), env })).key, "sig-1", { env });
  assert.equal(loadRun(dir).run.status, "paused");
  assert.equal(inspectRunLock(dir).state, "none");
  assert.equal(readdirSync(dir).includes("run.lock"), false);
});

// --- registry, flags, help ------------------------------------------------------------------------------

test("unknown flags and subcommands are usage errors (exit 2)", async () => {
  const fx = await fixture();
  for (const argv of [
    ["run", "show", "--jsno"],
    ["run", "show", "--script", "x"],
    ["run", "show", "--yes"],
    ["run", "approve", "run-1", "--yes"],
    ["run", "abort", "run-1", "--subject", "abcdef"],
    ["run", "frob"],
    ["run"],
  ]) {
    const result = await cli(argv, fx);
    assert.equal(result.code, 2, argv.join(" "));
    assert.equal(result.out, "");
  }
});

// --- review fixes -----------------------------------------------------------------------------------------

test("M4: a hostile core.worktree that widens the work tree to a parent directory is refused (REPO_WORKTREE_MISMATCH)", async () => {
  const outer = tempDir("aw-rc-outer-");
  const repo = join(outer, "hostile");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.worktree", outer.split("\\").join("/"));
  const env = cliEnv(tempDir("aw-rc-user-"));
  await assert.rejects(resolveRepo({ cwd: repo, env }), (error) => error.code === "REPO_WORKTREE_MISMATCH" && error.exitCode === 1 && /core\.worktree/.test(error.remediation));
  // ... also when that parent directory is itself a different repository
  git(outer, "init", "-b", "main");
  await assert.rejects(resolveRepo({ cwd: repo, env }), (error) => error.code === "REPO_WORKTREE_MISMATCH");
  const shown = await cli(["run", "show", "--json"], { env, cwd: repo });
  assert.equal(shown.code, 1);
  assert.equal(json(shown).error.code, "REPO_WORKTREE_MISMATCH");
});

test("M4: a linked worktree and a repository with a separate git dir are still accepted", async () => {
  const env = cliEnv(tempDir("aw-rc-user-"));
  const main = tempDir("aw-rc-main-");
  git(main, "init", "-b", "main");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", "a.txt");
  git(main, "commit", "-m", "first");
  const linked = join(tempDir("aw-rc-linked-"), "wt");
  git(main, "worktree", "add", "-b", "linked-branch", linked);
  const base = await resolveRepo({ cwd: main, env });
  const other = await resolveRepo({ cwd: linked, env });
  assert.equal(other.key, base.key, "one clone, one run directory");
  assert.equal(other.workspace, realpathSync.native(linked), "the linked work tree is its own workspace");

  const work = tempDir("aw-rc-sepwork-");
  const gitdir = join(tempDir("aw-rc-sepgit-"), "g");
  git(work, "init", "-b", "main", "--separate-git-dir", gitdir, work);
  const separate = await resolveRepo({ cwd: work, env });
  assert.equal(separate.workspace, realpathSync.native(work));
});

test("M1: inside a run (ASTERWEAVE_RUN_ID set) run show hides the subject hashes and the approve command", async () => {
  const fx = await fixture();
  const subject = planApproval(fx).subjectHash.slice(0, 12);
  const inRun = { ...fx, env: { ...fx.env, ASTERWEAVE_RUN_ID: "run-9" } };
  const asJson = json(await cli(["run", "show", "--json"], inRun));
  assert.deepEqual(asJson.run.approvals.map((entry) => entry.subject), ["hidden inside a run"]);
  const text = await cli(["run", "show"], inRun);
  assert.ok(text.out.includes("hidden inside a run"));
  assert.ok(!text.out.includes(subject), "the hash is nowhere in the output");
  assert.ok(!text.out.includes("Approve in a terminal"));
  const outside = await cli(["run", "show"], fx);
  assert.ok(outside.out.includes(subject) && outside.out.includes("Approve in a terminal"), "unchanged outside a run");
});

test("M3: a target is shown WHOLE with its length and who asked; newline, tab and backslash are visible escapes", async () => {
  const target = `echo a${" ".repeat(400)}&& DANGEROUS-TAIL\nline2\tx\\y`;
  const fx = await fixture({ plan: { intake: [{ node: "intake", action: { v: 1, type: "request-approval", approval: { operation: "shell", target } } }] } });
  assert.equal(fx.result.status, "waiting-approval");
  const text = await cli(["run", "show"], fx);
  assert.ok(text.out.includes("DANGEROUS-TAIL"), "nothing is clipped away");
  assert.ok(text.out.includes("\\nline2\\tx\\\\y"));
  assert.ok(text.out.includes(`target ${target.length} chars`));
  assert.ok(text.out.includes("requested by executor"));
  const approval = json(await cli(["run", "show", "--json"], fx)).run.approvals[0];
  assert.deepEqual([approval.scope.target, approval.targetLength, approval.requestedBy, approval.displayable], [target, target.length, "executor", true]);

  const yes = await inTty(["run", "approve", fx.runId], "y", fx);
  assert.equal(yes.code, 0);
  const prompt = yes.term.text();
  assert.ok(prompt.includes("DANGEROUS-TAIL") && prompt.includes("\\nline2\\tx\\\\y"));
  assert.match(prompt, /requested by {2}executor/);
  assert.ok(prompt.includes(`${target.length} characters`));
});

test("M3: the grant of a request whose scope cannot be shown faithfully is refused, in a terminal and with flags", async () => {
  const fx = await fixture();
  const seeded = seedApproval(fx, { operation: "deploy", target: `ok\u202Eevil` });
  const flags = await cli(["run", "approve", fx.runId, "--approval", seeded.id, "--subject", seeded.subjectHash.slice(0, 12), "--nonce", fx.nonces.get(seeded.id), "--json"], fx);
  assert.equal(flags.code, 1);
  assert.equal(json(flags).error.code, "UNDISPLAYABLE_TARGET");
  const tty = await cli(["run", "approve", fx.runId], { ...fx, stdin: fakeTerminal().stdin });
  assert.ok(loadRun(fx.dir).run.approvals.every((entry) => entry.grantedAt === null), `nothing granted (${tty.code})`);
});

test("S4: run approve refuses a request made under a policy that is no longer in force (APPROVAL_STALE)", async () => {
  const fx = await fixture();
  writeFileSync(join(fx.userDir, "policy.json"), JSON.stringify({ v: 1, mode: "autonomous", autonomous: { workflows: ["delivery@1"], repos: ["somewhere-else"], tools: ["read"], operations: ["commit"] } }));
  const result = await cli([...approveArgs(fx), "--json"], fx);
  assert.equal(result.code, 1, result.out);
  assert.equal(json(result).error.code, "APPROVAL_STALE");
  assert.equal(loadRun(fx.dir).run.approvals[0].grantedAt, null);
});

test("S5: approving several requests in a terminal is all-or-nothing", async () => {
  const fx = await fixture();
  seedApproval(fx, { operation: "deploy", target: "one" }); // ap-2, next to the plan approval ap-1
  const term = fakeTerminal();
  const running = runCli(["run", "approve", fx.runId], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: fx.env, cwd: repoDir(), proc: new EventEmitter() });
  const prompts = () => (term.text().match(/\[y\/N\]/g) ?? []).length;
  await waitFor(() => prompts() >= 1, { label: "the first prompt" });
  term.stdin.write("y");
  await waitFor(() => prompts() >= 2, { label: "the second prompt" });
  const lock = acquireRunLock(fx.dir);
  try {
    const { run } = loadRun(fx.dir);
    commitRecords({ dir: fx.dir, graph: fx.graph, lockToken: lock.token }, run, invalidateApproval(run, "ap-2", { now: new Date().toISOString(), cause: "test" }).events);
  } finally {
    lock.release();
  }
  term.stdin.write("y");
  assert.equal(await running, 1);
  assert.match(term.errText(), /changed while you were deciding/);
  const approvals = loadRun(fx.dir).run.approvals;
  assert.equal(approvals.find((entry) => entry.id === "ap-1").grantedAt, null, "the first 'y' was not applied on its own");
  assert.equal(readEvents(fx.dir).filter((event) => event.type === "approval.granted").length, 0);
});

test("S1: run abort after a kill completes the unfinished event group first, exactly once", async () => {
  const destructive = ["git", "reset", "--hard"].join(" ");
  const fx = await fixture({ plan: { intake: [{ node: "intake", action: tool("shell", { command: destructive }) }] } });
  const events = readEvents(fx.dir);
  const last = events.at(-1);
  assert.deepEqual([last.type, last.tx.i, last.tx.n], ["run.paused", 1, 2]);
  // A SIGKILL right after the first event of the group: the second line is missing, the snapshot is already final.
  const file = join(fx.dir, "events.jsonl");
  writeFileSync(file, `${readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, -1).join("\n")}\n`);
  const snapshotFile = join(fx.dir, "run.json");
  const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
  snapshot.lastSeq = last.seq - 1;
  writeFileSync(snapshotFile, JSON.stringify(snapshot));

  const aborted = await cli(["run", "abort", fx.runId, "--yes", "--json"], fx);
  assert.equal(aborted.code, 0, aborted.out + aborted.err);
  const after = readEvents(fx.dir);
  const group = after.filter((event) => event.tx?.id === last.tx.id);
  assert.deepEqual(group.map((event) => [event.type, event.tx.i]), [["node.completed", 0], ["run.paused", 1]], "the missing event was written, once");
  assert.ok(after.findIndex((event) => event.type === "run.aborted") > after.indexOf(group[1]), "before the abort's own events");
  assert.equal(loadRun(fx.dir).run.status, "aborted");
});

test("L2: a script must be a regular file and is size-checked in bytes BEFORE it is read", () => {
  const unreadable = () => {
    throw new Error("must not be read");
  };
  const fakeFs = (stat, read = unreadable) => ({ statSync: () => stat, readFileSync: read });
  assert.throws(() => loadScript("x.json", { fs: fakeFs({ isFile: () => true, size: 3_000_000 }) }), (error) => error.code === "SCRIPT_INVALID");
  assert.throws(() => loadScript("x.json", { fs: fakeFs({ isFile: () => false, size: 0 }) }), (error) => error.code === "SCRIPT_UNREADABLE");
  // A small file on disk that decodes to more bytes than the limit is caught after reading too.
  assert.throws(() => loadScript("x.json", { fs: fakeFs({ isFile: () => true, size: 10 }, () => "\u00e9".repeat(1_100_000)) }), (error) => error.code === "SCRIPT_INVALID");
  const directory = tempDir("aw-rc-script-");
  assert.throws(() => loadScript(directory), (error) => error.code === "SCRIPT_UNREADABLE");
});

test("L2: a FIFO is refused instead of blocking the command", { skip: process.platform === "win32" }, () => {
  const fifo = join(tempDir("aw-rc-fifo-"), "script.json");
  execFileSync("mkfifo", [fifo]);
  assert.throws(() => loadScript(fifo), (error) => error.code === "SCRIPT_UNREADABLE");
});

test("help lists exit codes 6 and 7 and the public run subcommands", async () => {
  assert.match(helpText(), /^ {2}6 {4}approval required/m);
  assert.match(helpText(), /^ {2}7 {4}policy denied/m);
  assert.match(usageText(), /^ {2}run {2,}\S/m);
  const help = await cli(["help", "run"], { env: cliEnv(tempDir("aw-rc-user-")) });
  assert.equal(help.code, 0);
  for (const word of ["run show", "run approve", "run abort", "run start", "run resume", "--subject", "Exit codes:"]) assert.ok(help.out.includes(word), word);
  assert.equal(JSON.stringify(helpText()).includes("ASTERWEAVE_DEV_EXECUTORS"), false);
});

// --- terminal-only approvals ------------------------------------------------------------------------------

test("TA1: flags without a nonce never grant (exit 2, terminal remediation); nothing is written", async () => {
  const fx = await fixture();
  const approval = planApproval(fx);
  const before = readEvents(fx.dir).length;
  const forged = await cli(["run", "approve", fx.runId, "--approval", approval.id, "--subject", approval.subjectHash.slice(0, 12), "--json"], fx);
  assert.equal(forged.code, 2);
  assert.equal(json(forged).error.code, "APPROVAL_TERMINAL_REQUIRED");
  assert.match(json(forged).error.remediation, /terminal/);
  const lone = await cli(["run", "approve", fx.runId, "--nonce", fx.nonces.get(approval.id), "--json"], fx);
  assert.equal(lone.code, 2, "--nonce alone is a usage error");
  assert.equal(readEvents(fx.dir).length, before);
  assert.equal(loadRun(fx.dir).run.approvals[0].grantedAt, null);
});

test("TA2: a wrong nonce fails with exit 7 and is counted in the ledger; five lock the request even against the right nonce", async () => {
  const fx = await fixture();
  const approval = planApproval(fx);
  const right = fx.nonces.get(approval.id);
  const wrong = "11111111-11111111-11111111-11111111";
  for (let i = 1; i <= MAX_FAILED_ATTEMPTS; i += 1) {
    const result = await cli([...approveArgs(fx, approval, undefined, wrong), "--json"], fx);
    assert.equal(result.code, 7, result.out);
    assert.equal(json(result).error.code, "APPROVAL_NONCE_INVALID");
    assert.equal(loadRun(fx.dir).run.approvals[0].failedAttempts, i, "the counter is in the request record");
  }
  assert.equal(readEvents(fx.dir).filter((event) => event.type === "approval.attempt-failed").length, MAX_FAILED_ATTEMPTS);
  const locked = await cli([...approveArgs(fx, approval, undefined, right), "--json"], fx);
  assert.equal(locked.code, 7);
  assert.equal(json(locked).error.code, "APPROVAL_LOCKED");
  assert.equal(loadRun(fx.dir).run.approvals[0].grantedAt, null);
  // The terminal prompt is not subject to the lock.
  assert.equal((await inTty(["run", "approve", fx.runId], "y", fx)).code, 0);
  assert.equal(inspectRunLock(fx.dir).state, "none");
});

test("TA3: a nonce is single use", async () => {
  const fx = await fixture();
  const args = [...approveArgs(fx), "--json"];
  assert.equal((await cli(args, fx)).code, 0);
  const again = await cli(args, fx);
  assert.equal(again.code, 1);
  assert.equal(json(again).error.code, "APPROVAL_ALREADY_GRANTED");
});

test("TA4: agent markers (ASTERWEAVE_SESSION_ID, CLAUDECODE, CLAUDE_CODE_*) refuse both paths with exit 7", async () => {
  const fx = await fixture();
  for (const marker of [{ ASTERWEAVE_SESSION_ID: "s1" }, { CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }]) {
    const env = { ...fx.env, ...marker };
    const flags = await cli([...approveArgs(fx), "--json"], { ...fx, env });
    assert.equal(flags.code, 7, JSON.stringify(marker));
    assert.equal(json(flags).error.code, "APPROVAL_FORBIDDEN_CONTEXT");
    const term = fakeTerminal();
    const code = await runCli(["run", "approve", fx.runId], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env, cwd: repoDir(), proc: new EventEmitter() });
    assert.equal(code, 7, "a real terminal does not help inside an agent session");
    assert.ok(!/\[y\/N\]/.test(term.text()), "no prompt is shown");
  }
  assert.equal(loadRun(fx.dir).run.approvals[0].grantedAt, null);
});

test("TA5: only a TTY supervisor shows the nonce, on its own stderr; it is in no file, no JSON and no stdout", async () => {
  const userDir = tempDir("aw-rc-user-");
  const env = cliEnv(userDir, { ASTERWEAVE_DEV_EXECUTORS: "1" });
  const file = writeScript(userDir, script(deliveryGraph));
  const term = fakeTerminal();
  const stdout = sink();
  const code = await runCli(["run", "start", "--executor", "fake", "--script", file, "--run-id", "ta5", "--json"], { stdin: sink(), stdout, stderr: term.stderr, env, cwd: repoDir(), proc: new EventEmitter() });
  assert.equal(code, 6);
  const shown = /One-time nonce: ([0-9a-f]{8}(?:-[0-9a-f]{8}){3})/.exec(term.errText());
  assert.ok(shown, term.errText());
  const nonce = shown[1];
  assert.ok(!stdout.text().includes(nonce) && !stdout.text().includes(nonce.replaceAll("-", "")), "not in the JSON result");
  const dir = runDir((await resolveRepo({ cwd: repoDir(), env })).key, "ta5", { env });
  const stored = treeText(dir) + treeText(userDir);
  assert.ok(!stored.includes(nonce) && !stored.includes(nonce.replaceAll("-", "")), "the plaintext is written nowhere");
  const shownRun = await cli(["run", "show", "ta5", "--json"], { env });
  assert.ok(!shownRun.out.includes(nonce));
  // It does approve, once, through the flags.
  const approval = json(shownRun).run.approvals[0];
  const ok = await cli(["run", "approve", "ta5", "--approval", approval.id, "--subject", approval.subject, "--nonce", nonce.toUpperCase(), "--json"], { env });
  assert.equal(ok.code, 0, ok.out + ok.err);
});

test("TA6: a restarted TTY supervisor issues a fresh nonce (hash only) for a request an earlier headless one made", async () => {
  const userDir = tempDir("aw-rc-user-");
  const env = cliEnv(userDir, { ASTERWEAVE_DEV_EXECUTORS: "1" });
  const file = writeScript(userDir, script(deliveryGraph));
  assert.equal((await cli(["run", "start", "--executor", "fake", "--script", file, "--run-id", "ta6", "--json"], { env })).code, 6);
  const term = fakeTerminal();
  const code = await runCli(["run", "resume", "ta6", "--executor", "fake", "--script", file, "--json"], { stdin: sink(), stdout: sink(), stderr: term.stderr, env, cwd: repoDir(), proc: new EventEmitter() });
  assert.equal(code, 6);
  const nonce = /One-time nonce: ([0-9a-f-]{35})/.exec(term.errText())?.[1];
  assert.ok(nonce, term.errText());
  const dir = runDir((await resolveRepo({ cwd: repoDir(), env })).key, "ta6", { env });
  assert.ok(readEvents(dir).some((event) => event.type === "approval.nonce-issued" && !JSON.stringify(event).includes(nonce)));
  assert.ok(!treeText(dir).includes(nonce));
  const approval = json(await cli(["run", "show", "ta6", "--json"], { env })).run.approvals[0];
  assert.equal((await cli(["run", "approve", "ta6", "--approval", approval.id, "--subject", approval.subject, "--nonce", nonce, "--json"], { env })).code, 0);
});

test("TA7: a request without nonceHash (an old run) can only be approved at the terminal prompt", async () => {
  const fx = await fixture();
  const lock = acquireRunLock(fx.dir);
  try {
    // Rewrite the snapshot the way a pre-D-b build left it: no nonce fields at all.
    const file = join(fx.dir, "run.json");
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    for (const approval of snapshot.approvals) for (const key of ["nonceHash", "nonceExpiresAt", "failedAttempts", "lastFailedAt"]) delete approval[key];
    writeFileSync(file, JSON.stringify(snapshot));
  } finally {
    lock.release();
  }
  const approval = planApproval(fx);
  const flags = await cli(approveArgs(fx, approval, undefined, fx.nonces.get(approval.id)), fx);
  assert.equal(flags.code, 2, flags.out + flags.err);
  assert.equal((await inTty(["run", "approve", fx.runId], "y", fx)).code, 0);
});

test("TA7b: a TTY supervisor that resumes does NOT issue a nonce for a legacy request without nonceHash; it stays terminal-only", async () => {
  const userDir = tempDir("aw-rc-user-");
  const env = cliEnv(userDir, { ASTERWEAVE_DEV_EXECUTORS: "1" });
  const file = writeScript(userDir, script(deliveryGraph));
  assert.equal((await cli(["run", "start", "--executor", "fake", "--script", file, "--run-id", "ta7b", "--json"], { env })).code, 6);
  const dir = runDir((await resolveRepo({ cwd: repoDir(), env })).key, "ta7b", { env });
  const snapshotFile = join(dir, "run.json");
  const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
  for (const approval of snapshot.approvals) for (const key of ["nonceHash", "nonceExpiresAt", "failedAttempts", "lastFailedAt"]) delete approval[key];
  writeFileSync(snapshotFile, JSON.stringify(snapshot));
  const term = fakeTerminal();
  const code = await runCli(["run", "resume", "ta7b", "--executor", "fake", "--script", file, "--json"], { stdin: sink(), stdout: sink(), stderr: term.stderr, env, cwd: repoDir(), proc: new EventEmitter() });
  assert.equal(code, 6);
  assert.ok(!/One-time nonce/.test(term.errText()), "no nonce is shown for a legacy request");
  assert.ok(!readEvents(dir).some((event) => event.type === "approval.nonce-issued"), "and none is stored");
  const approval = json(await cli(["run", "show", "ta7b", "--json"], { env })).run.approvals[0];
  const flags = await cli(["run", "approve", "ta7b", "--approval", approval.id, "--subject", approval.subject, "--nonce", "00000000-00000000-00000000-00000000", "--json"], { env });
  assert.equal(flags.code, 2);
  assert.equal(json(flags).error.code, "APPROVAL_TERMINAL_REQUIRED");
});
