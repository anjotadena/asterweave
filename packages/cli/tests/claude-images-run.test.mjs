// `run start --image` end to end through the real loop and the scriptable fake claude (a REAL child process). No network, no model.
// Proves what the CHILD received (decoded sha256 recorded by the fake), that images ride the first turn only, and that the ledger
// holds hashes only. Temp user directories only.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/args.mjs";
import { createRunCommand, resolveRepo, runCommandMeta } from "../src/commands/run.mjs";
import { inspectImage, listAttachments, removeAttachment } from "../src/runtime/attachments.mjs";
import { CATALOG } from "../src/runtime/routing.mjs";
import { createSession, listSessions, loadSession } from "../src/runtime/sessions.mjs";
import { runDir } from "../src/runtime/ledger.mjs";
import { grantTrust } from "../src/trust.mjs";
import { readEvents } from "./loop-fixture.mjs";
import { exifPayload, makeJpeg, makePng } from "./image-fixture.mjs";
import { cleanupTemp, git, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const SID = "11111111-2222-4333-8444-555555555555";
const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};

let sharedRepo;
function repoDir() {
  if (sharedRepo) return sharedRepo;
  sharedRepo = tempDir("aw-ci-repo-");
  git(sharedRepo, "init", "-b", "main");
  writeFileSync(join(sharedRepo, "README.md"), "hello\n");
  git(sharedRepo, "add", "README.md");
  git(sharedRepo, "commit", "-m", "initial");
  return sharedRepo;
}

async function fixture(scenario = {}, { envExtra = {}, trust = true } = {}) {
  const userDir = tempDir("aw-ci-user-");
  const scenarioFile = join(userDir, "scenario.json");
  const logFile = join(userDir, "turns.jsonl");
  writeFileSync(scenarioFile, JSON.stringify({ protocol: true, sessionId: SID, recordLog: logFile, ...scenario }));
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, { ASTERWEAVE_CONFIG_DIR: userDir }, envExtra);
  if (trust) grantTrust(repoDir(), { env });
  const identity = await resolveRepo({ cwd: repoDir(), env });
  const files = tempDir("aw-ci-img-");
  return {
    userDir, env, identity, files, scenarioFile,
    setScenario: (next) => writeFileSync(scenarioFile, JSON.stringify({ protocol: true, sessionId: SID, recordLog: logFile, ...next })),
    file: (name, bytes) => { writeFileSync(join(files, name), bytes); return join(files, name); },
    claude: { claudePath: process.execPath, claudeArgs: [FAKE, "--fake-scenario", scenarioFile] },
    turns: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
    dir: (runId) => runDir(identity.key, runId, { env }),
    ledgerText: (runId) => readFileSync(join(runDir(identity.key, runId, { env }), "events.jsonl"), "utf8"),
    events: (runId) => readEvents(runDir(identity.key, runId, { env })),
  };
}

async function runCmd(fx, argv, { catalog, spawn, imageStore } = {}) {
  const stdout = sink();
  const stderr = sink();
  const parsed = parseArgs(argv, { boolean: [...runCommandMeta.boolean, "help", "version"] });
  const handler = createRunCommand({ claude: spawn ? { ...fx.claude, spawn } : fx.claude, loopOptions: { sleep: async () => {} }, ...(catalog ? { catalog } : {}), ...(imageStore ? { imageStore } : {}) });
  const context = { stdin: sink(), stdout, stderr, env: fx.env, cwd: repoDir(), name: "run", argv, ...parsed };
  try {
    const code = await handler(context);
    let body = null;
    try { body = JSON.parse(stdout.text()); } catch { /* text output */ }
    return { code, out: stdout.text(), err: stderr.text(), body };
  } catch (error) {
    return { error, code: error.exitCode, out: stdout.text(), err: stderr.text(), body: null };
  }
}

test("run start --image: the child receives exactly the stripped bytes on the first turn only; the ledger holds hashes only", async () => {
  const fx = await fixture();
  const png = fx.file("diagram.png", makePng({ width: 4, height: 4, before: [["tEXt", Buffer.from("Author\0secret-author")]] }));
  const jpg = fx.file("photo.jpg", makeJpeg({ segments: [[0xe1, exifPayload()]] }));
  const expected = [png, jpg].map((path) => inspectImage(path).image);
  const started = await runCmd(fx, ["start", "look at these", "--run-id", "img1", "--image", png, "--image", jpg, "--json"]);
  assert.equal(started.code, 6, started.err + started.out + (started.error?.message ?? ""));
  assert.equal(started.body.status, "waiting-approval");

  const turns = fx.turns();
  assert.equal(turns.length, 4, "intake, analyze, challenge, plan");
  assert.deepEqual(turns[0].blockTypes, ["image", "image", "text"]);
  assert.deepEqual(turns[0].images.map((image) => [image.mediaType, image.decodedBytes, image.decodedSha256]), expected.map((image) => [image.mime, image.bytes, image.sha256]), "the stripped bytes, not the originals");
  assert.ok(turns[0].argv.includes("--input-format"));
  for (const later of turns.slice(1)) {
    assert.equal(later.images, undefined, "later turns carry no images");
    assert.equal(later.argv.includes("--input-format"), false);
    assert.ok(later.argv.includes("--resume"), "later turns resume the provider session");
  }

  const sent = fx.events("img1").filter((event) => event.type === "attachments.sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].node, "intake");
  assert.equal(sent[0].count, 2);
  assert.equal(sent[0].bytes, expected[0].bytes + expected[1].bytes);
  assert.equal(sent[0].sha256, expected.map((image) => image.sha256.slice(0, 12)).join(","));
  assert.equal(sent[0].turnOk, true);
  const ledger = fx.ledgerText("img1");
  for (const image of [png, jpg]) assert.equal(ledger.includes(readFileSync(image).toString("base64").slice(0, 32)), false);
  assert.equal(ledger.includes("secret-author"), false);
  assert.equal(ledger.includes("GPSLatitude"), false);

  // JSON output: hashes and sizes only, plus the sent marker in the session
  assert.deepEqual(started.body.attachments.map((item) => item.sha256), expected.map((image) => image.sha256));
  assert.equal(JSON.stringify(started.body).includes(readFileSync(png).toString("base64").slice(0, 32)), false);
  const options = { userDir: fx.userDir, env: fx.env, repoKey: fx.identity.key };
  const [session] = listSessions(fx.identity.key, options).sessions;
  const stored = listAttachments(session.id, options);
  assert.equal(stored.length, 2);
  assert.ok(stored.every((item) => item.sentRunId === "img1"));
  assert.equal(loadSession(fx.identity.key, session.id, options).session.runId, "img1");
});

test("run start --image in text mode prints exactly what will be sent before the first turn", async () => {
  const fx = await fixture();
  const png = fx.file("a b.png", makePng({ width: 9, height: 7 }));
  const result = await runCmd(fx, ["start", "look", "--run-id", "img2", "--image", png]);
  assert.equal(result.code, 6, result.err + result.out);
  const lines = result.out.split("\n");
  const sendingAt = lines.findIndex((line) => line.startsWith("Sending 1 image(s)"));
  const runAt = lines.findIndex((line) => line.startsWith("Run img2"));
  assert.ok(sendingAt >= 0 && sendingAt < runAt, result.out);
  assert.match(lines[sendingAt + 1], /a b\.png\s+png\s+1 KiB\s+9x7\s+sha256 [0-9a-f]{12}\s+metadata stripped/);
  assert.match(result.out, /each attempt of the first turn/);
  assert.match(result.err, /No model is configured/, "an unset model only warns");
});

test("a session's staged images go with the run's first turn, once; a second run in the session sends nothing", async () => {
  const fx = await fixture();
  const { createSession } = await import("../src/runtime/sessions.mjs");
  const { addAttachment } = await import("../src/runtime/attachments.mjs");
  const options = { userDir: fx.userDir, env: fx.env, repoKey: fx.identity.key };
  const session = createSession({ repoKey: fx.identity.key, workspace: fx.identity.workspace, title: "staged" }, options).session;
  const image = makePng({ width: 3, height: 3 });
  assert.equal(addAttachment(session.id, image, { ...options, name: "staged.png" }).ok, true);
  const first = await runCmd(fx, ["start", "go", "--run-id", "img3", "--session", session.id, "--json"]);
  assert.equal(first.code, 6, first.err + first.out);
  assert.equal(first.body.attachments.length, 1);
  assert.equal(fx.turns()[0].images.length, 1);
  const turnsBefore = fx.turns().length;
  const second = await runCmd(fx, ["start", "again", "--run-id", "img4", "--session", session.id, "--json"]);
  assert.equal(second.code, 6, second.err + second.out);
  assert.equal(second.body.attachments, undefined);
  assert.equal(fx.turns().slice(turnsBefore).every((turn) => turn.images === undefined), true);
});

test("a model without image input is refused with exit 2 and a remediation, before anything is created", async () => {
  const noImages = { ...CATALOG, "claude-blind-1": { ...CATALOG["claude-haiku-5-5"], id: "claude-blind-1", features: { tools: true, images: false } } };
  const fx = await fixture({}, { envExtra: { ASTERWEAVE_MODEL: "claude-blind-1" } });
  const png = fx.file("a.png", makePng());
  const refused = await runCmd(fx, ["start", "look", "--run-id", "img5", "--image", png, "--json"], { catalog: noImages });
  assert.equal(refused.code, 2);
  assert.equal(refused.error.code, "IMAGE_MODEL_UNSUPPORTED");
  assert.match(refused.error.remediation, /model show/);
  assert.equal(fx.turns().length, 0, "no child started");
  assert.equal(existsSync(fx.dir("img5")), false, "no run directory");
  assert.equal(listSessions(fx.identity.key, { userDir: fx.userDir, env: fx.env }).sessions.length, 0, "no session");

  // a fallback model without images is refused too
  const fx2 = await fixture({}, { envExtra: { ASTERWEAVE_MODEL: "claude-sonnet-5-5", ASTERWEAVE_MODEL_FALLBACK: "claude-blind-1" } });
  assert.equal((await runCmd(fx2, ["start", "look", "--image", fx2.file("a.png", makePng())], { catalog: noImages })).code, 2);

  // an unknown model only warns, and the run proceeds
  const fx3 = await fixture({}, { envExtra: { ASTERWEAVE_MODEL: "my-custom-model" } });
  const warned = await runCmd(fx3, ["start", "look", "--run-id", "img6", "--image", fx3.file("a.png", makePng())]);
  assert.equal(warned.code, 6, warned.err + warned.out);
  assert.match(warned.err, /my-custom-model is not in the static catalog/);
  assert.equal(fx3.turns()[0].images.length, 1);
});

test("oversize, invalid and missing images are refused (exit 2) before trust, a session or any child", async () => {
  const fx = await fixture({}, { trust: false });
  const big = fx.file("big.png", Buffer.concat([makePng(), Buffer.alloc(5 * 1024 * 1024)]));
  const gif = fx.file("x.gif", Buffer.from("GIF89a\x01\0\x01\0\x80\0\0", "latin1"));
  for (const path of [big, gif, join(fx.files, "missing.png")]) {
    const result = await runCmd(fx, ["start", "look", "--run-id", "img7", "--image", path, "--json"]);
    assert.equal(result.code, 2, path);
    assert.equal(result.error.code, "IMAGE_INVALID");
  }
  assert.equal(fx.turns().length, 0);
  assert.equal(existsSync(fx.dir("img7")), false);
  assert.equal(listSessions(fx.identity.key, { userDir: fx.userDir, env: fx.env }).sessions.length, 0);
  assert.equal((await runCmd(fx, ["start", "look", "--image"])).code, 2, "a bare --image has no path");
});

test("a child that rejects images blocks the node; the images stay claimed and unsent; a resume sends them, once", async () => {
  const fx = await fixture({ rejectImages: true });
  const options = { userDir: fx.userDir, env: fx.env, repoKey: fx.identity.key };
  const result = await runCmd(fx, ["start", "look", "--run-id", "img8", "--image", fx.file("a.png", makePng()), "--json"]);
  assert.equal(result.code, 1, result.err + result.out);
  assert.equal(result.body.status, "blocked");
  assert.equal(result.body.runnerFailure.class, "invalid-request");
  const [session] = listSessions(fx.identity.key, options).sessions;
  const [claimedItem] = listAttachments(session.id, options);
  assert.equal(claimedItem.sentRunId, null, "not marked sent: no turn succeeded with them");
  assert.equal(claimedItem.claimedRunId, "img8", "claimed by the run BEFORE its first turn");
  const sentBefore = fx.events("img8").filter((event) => event.type === "attachments.sent");
  assert.equal(sentBefore.length, 1);
  assert.equal(sentBefore[0].turnOk, false);
  assert.equal(fx.turns().length, 1);
  // claimed-but-unsent images cannot be detached while the run is open
  assert.equal(removeAttachment(session.id, claimedItem.id, { ...options, confirm: true }).problems[0].code, "ATTACHMENT_IN_USE");

  // a second run in the same session does not take the claimed image
  const other = await runCmd(fx, ["start", "other", "--run-id", "img8b", "--session", session.id, "--json"]);
  assert.ok(fx.turns().length > 1 && fx.turns().slice(1).every((turn) => turn.images === undefined), "the other run sent no image");
  assert.equal(fx.turns()[1].images, undefined);

  // the child accepts images now: the resume sends the still-unsent ones with its first turn, once
  fx.setScenario({});
  const turnsBefore = fx.turns().length;
  const resumed = await runCmd(fx, ["resume", "img8", "--json"]);
  assert.equal(resumed.code, 6, resumed.err + resumed.out);
  assert.equal(resumed.body.status, "waiting-approval");
  assert.equal(resumed.body.attachments.length, 1);
  const turns = fx.turns().slice(turnsBefore);
  assert.equal(turns[0].images.length, 1);
  assert.ok(turns.length >= 2 && turns.slice(1).every((turn) => turn.images === undefined), "only the first turn of the resume carries them");
  assert.equal(turns[0].argv.includes("--resume"), false, "a fresh provider session while images are pending");
  const sent = fx.events("img8").filter((event) => event.type === "attachments.sent");
  assert.deepEqual(sent.map((event) => event.turnOk), [false, true]);
  assert.equal(listAttachments(session.id, options)[0].sentRunId, "img8");
  // a second resume sends nothing again
  const again = await runCmd(fx, ["resume", "img8", "--json"]);
  assert.equal(again.body?.attachments, undefined);
  assert.equal(fx.events("img8").filter((event) => event.type === "attachments.sent").length, 2);
});

test("a duplicate --run-id fails before any session or stored image exists", async () => {
  const fx = await fixture();
  const first = await runCmd(fx, ["start", "one", "--run-id", "dup1", "--json"]);
  assert.equal(first.code, 6, first.err + first.out);
  const sessionsBefore = listSessions(fx.identity.key, { userDir: fx.userDir, env: fx.env }).sessions.length;
  const dup = await runCmd(fx, ["start", "two", "--run-id", "dup1", "--image", fx.file("a.png", makePng()), "--json"]);
  assert.notEqual(dup.code, 0);
  assert.notEqual(dup.code, 6);
  assert.equal(listSessions(fx.identity.key, { userDir: fx.userDir, env: fx.env }).sessions.length, sessionsBefore, "no implicit session was created");

  // an existing session keeps its attachments unchanged
  const options = { userDir: fx.userDir, env: fx.env, repoKey: fx.identity.key };
  const session = createSession({ repoKey: fx.identity.key, workspace: fx.identity.workspace, title: "keep" }, options).session;
  const dup2 = await runCmd(fx, ["start", "three", "--run-id", "dup1", "--session", session.id, "--image", fx.file("b.png", makePng({ width: 3, height: 3 })), "--json"]);
  assert.notEqual(dup2.code, 6);
  assert.deepEqual(listAttachments(session.id, options), [], "the copy was not stored: the run was never created");
});

test("the list that is SENT is checked, not an earlier one: an image that appears late is still model-checked and capped", async () => {
  const noImages = { ...CATALOG, "claude-blind-1": { ...CATALOG["claude-haiku-5-5"], id: "claude-blind-1", features: { tools: true, images: false } } };
  const fx = await fixture({}, { envExtra: { ASTERWEAVE_MODEL: "claude-blind-1" } });
  const options = { userDir: fx.userDir, env: fx.env, repoKey: fx.identity.key };
  const session = createSession({ repoKey: fx.identity.key, workspace: fx.identity.workspace, title: "late" }, options).session;
  const late = { id: "img_aaaaaaaaaaaa", sha256: "a".repeat(64), format: "png", mime: "image/png", bytes: 10, width: 1, height: 1, name: "late.png", metadataStripped: true, dropped: [], sentRunId: null, claimedRunId: null };
  // T1 (the session record) holds no image; at T2 (the list read for sending) one has appeared
  const refused = await runCmd(fx, ["start", "go", "--run-id", "late1", "--session", session.id, "--json"], { catalog: noImages, imageStore: { listAttachments: () => [late] } });
  assert.equal(refused.code, 2);
  assert.equal(refused.error.code, "IMAGE_MODEL_UNSUPPORTED");
  assert.match(refused.error.remediation, /run abort late1/);
  assert.equal(fx.turns().length, 0, "no child started");

  const many = Array.from({ length: 11 }, (_, n) => ({ ...late, id: `img_${String(n).padStart(12, "b")}`, sha256: String(n).padStart(64, "b") }));
  const fx2 = await fixture();
  const session2 = createSession({ repoKey: fx2.identity.key, workspace: fx2.identity.workspace, title: "late2" }, { userDir: fx2.userDir, env: fx2.env, repoKey: fx2.identity.key }).session;
  const capped = await runCmd(fx2, ["start", "go", "--run-id", "late2", "--session", session2.id, "--json"], { imageStore: { listAttachments: () => many } });
  assert.equal(capped.code, 2);
  assert.equal(capped.error.code, "TOO_MANY");
  assert.equal(fx2.turns().length, 0);
});

test("claude not installed is unaffected by --image: exit 1 with the usual remediation, nothing created", async () => {
  const fx = await fixture();
  fx.claude.claudePath = join(fx.files, "no-such-claude.exe");
  const png = fx.file("a.png", makePng());
  const result = await runCmd(fx, ["start", "look", "--run-id", "img9", "--image", png, "--json"]);
  assert.equal(result.code, 1);
  assert.match(result.error.code, /^RUNNER_/);
  assert.equal(existsSync(fx.dir("img9")), false);
  assert.equal(listSessions(fx.identity.key, { userDir: fx.userDir, env: fx.env }).sessions.length, 0);
});

test("run start without --image keeps its JSON shape (no attachments key) and sends plain text", async () => {
  const fx = await fixture();
  const result = await runCmd(fx, ["start", "plain", "--run-id", "img10", "--json"]);
  assert.equal(result.code, 6);
  assert.equal("attachments" in result.body, false);
  assert.equal(fx.turns().every((turn) => turn.images === undefined && !turn.argv.includes("--input-format")), true);
});

test("an image claimed by another open run is not taken at claim time (compare-and-set), and the run says so", async () => {
  const fx = await fixture({ rejectImages: true });
  const options = { userDir: fx.userDir, env: fx.env, repoKey: fx.identity.key };
  const first = await runCmd(fx, ["start", "look", "--run-id", "held1", "--image", fx.file("a.png", makePng()), "--json"]);
  assert.equal(first.body.status, "blocked");
  const [session] = listSessions(fx.identity.key, options).sessions;
  // a stale view of the session (as another process would have it) lists the image as free: only the claim itself can tell
  const stale = { listAttachments: (id, opts) => listAttachments(id, opts).map((item) => ({ ...item, claimedRunId: null })) };
  const turnsBefore = fx.turns().length;
  const second = await runCmd(fx, ["start", "other", "--run-id", "held2", "--session", session.id, "--json"], { imageStore: stale });
  assert.equal(second.code, 6, second.err + second.out);
  assert.deepEqual(second.body.attachments, []);
  assert.match(second.body.imageWarnings.join("\n"), /1 staged image\(s\) are held by open run held1/);
  assert.equal(fx.turns().slice(turnsBefore).every((turn) => turn.images === undefined), true, "nothing was sent");
  assert.equal(listAttachments(session.id, options)[0].claimedRunId, "held1", "the first claim stands");
  // text mode: the same fact on stderr
  const text = await runCmd(fx, ["start", "again", "--run-id", "held3", "--session", session.id], { imageStore: stale });
  assert.match(text.err, /1 staged image\(s\) are held by open run held1/);
});
