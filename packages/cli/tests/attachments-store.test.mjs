// Attachment store: content-addressed copies in the session directory, session record migration, dedupe, limits, removal.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { addAttachment, claimAttachments, listAttachments, markAttachmentsSent, pendingAttachments, isDeviceOrUncPath, readAttachmentBytes, readImageFile, removeAttachment } from "../src/runtime/attachments.mjs";
import { runDir } from "../src/runtime/ledger.mjs";
import { cleanApply, cleanPlan } from "../src/runtime/session-maint.mjs";
import { archiveSession, createSession, forkSession, loadSession, repoSessionsDir } from "../src/runtime/sessions.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";
import { exifPayload, makeJpeg, makePng, makeWebp, EXIF_GPS_TEXT } from "./image-fixture.mjs";
import { makeBox, startRun } from "./loop-fixture.mjs";

after(cleanupTemp);

const REPO = "repo-key-attach";
function fixture() {
  const userDir = tempDir("aw-att-");
  const opts = { userDir, repoKey: REPO };
  const { session, dir } = createSession({ repoKey: REPO, workspace: "/work/space", branch: "main", title: "Images" }, { userDir });
  return { userDir, opts, session, dir, id: session.id };
}
const photo = () => makeJpeg({ segments: [[0xe1, exifPayload()]] });
const readLines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("addAttachment stores the STRIPPED bytes as <sha256>.<ext> and records metadata on the session", () => {
  const { opts, id, dir } = fixture();
  const original = photo();
  const result = addAttachment(id, original, { ...opts, name: "holiday.jpg" });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const { attachment } = result;
  assert.match(attachment.id, /^img_[0-9a-f]{12}$/);
  assert.equal(attachment.id, `img_${attachment.sha256.slice(0, 12)}`);
  assert.deepEqual([attachment.format, attachment.mime, attachment.width, attachment.height, attachment.name, attachment.metadataStripped], ["jpeg", "image/jpeg", 7, 9, "holiday.jpg", true]);
  assert.deepEqual(attachment.dropped, ["exif"]);
  assert.equal(attachment.sentRunId, null);
  const file = join(dir, "attachments", `${attachment.sha256}.jpg`);
  const stored = readFileSync(file);
  assert.equal(stored.length, attachment.bytes);
  assert.equal(stored.includes(Buffer.from("GPSLatitude")), false, "stored copy has no EXIF");
  assert.notDeepEqual(stored, original);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(dir, "attachments")), [`${attachment.sha256}.jpg`], "no temp files are left");
  // the record is durable: snapshot AND event log
  const loaded = loadSession(REPO, id, opts).session;
  assert.deepEqual(loaded.attachments, [attachment]);
  const events = readLines(join(dir, "events.jsonl"));
  assert.equal(events.at(-1).type, "attachment.added");
  assert.equal(events.at(-1).attachmentId, attachment.id);
});

test("no image bytes, base64 or EXIF text reach session.json or events.jsonl", () => {
  const { opts, id, dir } = fixture();
  const original = photo();
  addAttachment(id, original, opts);
  for (const file of ["session.json", "events.jsonl"]) {
    const text = readFileSync(join(dir, file), "latin1");
    assert.equal(text.includes(EXIF_GPS_TEXT), false, file);
    assert.equal(text.includes(original.toString("base64").slice(0, 40)), false, file);
    assert.equal(text.includes(original.toString("hex").slice(0, 60)), false, file);
  }
});

test("same content is deduplicated: one file, one record, no new event", () => {
  const { opts, id, dir } = fixture();
  const first = addAttachment(id, makePng(), { ...opts, name: "a.png" });
  const before = readLines(join(dir, "events.jsonl")).length;
  const second = addAttachment(id, makePng(), { ...opts, name: "renamed.png" });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.attachment.id, first.attachment.id);
  assert.equal(second.attachment.name, "a.png", "the first record wins");
  assert.equal(readLines(join(dir, "events.jsonl")).length, before);
  assert.equal(readdirSync(join(dir, "attachments")).length, 1);
  // the same picture with different metadata hashes identically once stripped
  const withExif = makePng({ before: [["tEXt", Buffer.from("Author\0someone")]] });
  assert.equal(addAttachment(id, withExif, opts).duplicate, true);
});

test("the sessions list limit, archived sessions and invalid sources are refused without writing", () => {
  const { opts, id, dir } = fixture();
  const limits = { perSession: 2 };
  assert.equal(addAttachment(id, makePng({ width: 2, height: 2 }), { ...opts, limits }).ok, true);
  assert.equal(addAttachment(id, makePng({ width: 3, height: 3 }), { ...opts, limits }).ok, true);
  const third = addAttachment(id, makePng({ width: 4, height: 4 }), { ...opts, limits });
  assert.equal(third.ok, false);
  assert.equal(third.problems[0].code, "TOO_MANY");
  assert.equal(readdirSync(join(dir, "attachments")).length, 2, "nothing was written for the refused image");
  assert.equal(addAttachment(id, Buffer.from("GIF89a"), opts).problems[0].code, "UNSUPPORTED_FORMAT");
  assert.equal(addAttachment(id, join(dir, "no-such.png"), opts).problems[0].code, "NOT_FOUND");
  archiveSession(REPO, id, opts);
  assert.equal(addAttachment(id, makePng({ width: 5, height: 5 }), { ...opts, limits: { perSession: 9 } }).problems[0].code, "SESSION_ARCHIVED");
});

test("the real default limit is 20 images per session", () => {
  const { opts, id } = fixture();
  for (let n = 1; n <= 20; n += 1) assert.equal(addAttachment(id, makePng({ width: n, height: 1 }), opts).ok, true, String(n));
  assert.equal(addAttachment(id, makePng({ width: 21, height: 1 }), opts).problems[0].code, "TOO_MANY");
  assert.equal(listAttachments(id, opts).length, 20);
});

test("the session is found by id alone, and bad ids and unknown sessions are problems, not exceptions", () => {
  const { userDir, id } = fixture();
  const noRepo = { userDir };
  const result = addAttachment(id, makePng(), noRepo);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(listAttachments(id, noRepo).length, 1);
  assert.equal(addAttachment("s_0000000000000000", makePng(), noRepo).problems[0].code, "SESSION_NOT_FOUND");
  assert.equal(addAttachment("../escape", makePng(), noRepo).problems[0].code, "SESSION_ID_INVALID");
  assert.deepEqual(listAttachments("s_0000000000000000", noRepo), []);
});

test("older records without attachments load as []; v1 records migrate with []; a fork starts empty", () => {
  const { opts, id, dir } = fixture();
  assert.deepEqual(loadSession(REPO, id, opts).session.attachments, []);
  const raw = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
  delete raw.attachments;
  writeFileSync(join(dir, "session.json"), JSON.stringify(raw));
  assert.deepEqual(loadSession(REPO, id, { ...opts, repair: false }).session.attachments, []);
  const v1 = fixture();
  writeFileSync(join(v1.dir, "session.json"), JSON.stringify({ id: v1.id, repoKey: REPO, workspace: "/w", createdAt: "2026-01-01T00:00:00.000Z", runId: null }));
  assert.deepEqual(loadSession(REPO, v1.id, { ...v1.opts, repair: false }).session.attachments, []);
  const donor = fixture();
  addAttachment(donor.id, makePng(), donor.opts);
  const forked = forkSession(REPO, donor.id, donor.opts);
  assert.deepEqual(forked.session.attachments, []);
  assert.equal(listAttachments(donor.id, donor.opts).length, 1);
});

test("hostile attachment records in session.json are dropped on load (bad ids, hashes, sizes, duplicates)", () => {
  const { opts, id, dir } = fixture();
  const good = addAttachment(id, makePng(), opts).attachment;
  const raw = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
  raw.attachments = [
    good, { ...good },
    { ...good, id: "img_../../etc" },
    { ...good, sha256: "z".repeat(64) },
    { ...good, id: "img_000000000000" },
    { ...good, format: "gif" },
    { ...good, bytes: -1 },
    { ...good, width: 100000, sha256: "a".repeat(64), id: `img_${"a".repeat(12)}` },
    "not an object", null,
  ];
  writeFileSync(join(dir, "session.json"), JSON.stringify(raw));
  assert.deepEqual(loadSession(REPO, id, { ...opts, repair: false }).session.attachments.map((item) => item.id), [good.id]);
});

test("a lost or corrupt snapshot is rebuilt from the events, attachments included", () => {
  const { opts, id, dir } = fixture();
  const added = addAttachment(id, makeWebp(), opts).attachment;
  writeFileSync(join(dir, "session.json"), "{ not json");
  const loaded = loadSession(REPO, id, opts);
  assert.deepEqual(loaded.session.attachments.map((item) => item.id), [added.id]);
});

test("removeAttachment previews first and deletes only that stored copy", () => {
  const { opts, id, dir } = fixture();
  const keep = addAttachment(id, makePng({ width: 2, height: 2 }), opts).attachment;
  const drop = addAttachment(id, makePng({ width: 3, height: 3 }), opts).attachment;
  const stray = join(dir, "attachments", "stray.txt");
  writeFileSync(stray, "not an attachment");
  const preview = removeAttachment(id, drop.id, opts);
  assert.equal(preview.ok, true);
  assert.equal(preview.removed, false);
  assert.equal(preview.preview.id, drop.id);
  assert.equal(listAttachments(id, opts).length, 2, "a preview changes nothing");
  assert.equal(existsSync(join(dir, "attachments", `${drop.sha256}.png`)), true);
  const done = removeAttachment(id, drop.id.slice(0, 10), { ...opts, confirm: true });
  assert.equal(done.removed, true);
  assert.deepEqual(listAttachments(id, opts).map((item) => item.id), [keep.id]);
  assert.equal(existsSync(join(dir, "attachments", `${drop.sha256}.png`)), false);
  assert.equal(existsSync(join(dir, "attachments", `${keep.sha256}.png`)), true);
  assert.equal(existsSync(stray), true, "nothing else in the directory is touched");
  assert.equal(readLines(join(dir, "events.jsonl")).at(-1).type, "attachment.removed");
});

test("removeAttachment: bad, unknown and ambiguous ids are refused", () => {
  const { opts, id } = fixture();
  addAttachment(id, makePng({ width: 2, height: 2 }), opts);
  for (const bad of ["", "img_", "../../x", "img_zz", "nothing", "img_0000000000000"]) {
    const result = removeAttachment(id, bad, { ...opts, confirm: true });
    assert.equal(result.ok, false, bad);
    assert.equal(result.removed, false);
  }
  assert.equal(removeAttachment(id, "img_000000000000", { ...opts, confirm: true }).problems[0].code, "ATTACHMENT_NOT_FOUND");
  assert.equal(listAttachments(id, opts).length, 1);
});

test("removeAttachment refuses while an open run used the image, and allows it once the run is finished or gone", () => {
  const box = makeBox();
  const repoKey = box.repo.key;
  const created = createSession({ repoKey, workspace: box.workspace, title: "with run" }, { userDir: box.userDir });
  const sid = created.session.id;
  const opts = { userDir: box.userDir, repoKey, env: box.env };
  const image = addAttachment(sid, makePng(), opts).attachment;
  assert.equal(removeAttachment(sid, image.id, opts).ok, true, "never sent: removable");
  const run = startRun(box, { runId: "run-att" });
  assert.equal(markAttachmentsSent(sid, [image.id], "run-att", opts).marked.length, 1);
  assert.equal(markAttachmentsSent(sid, [image.id], "run-other", opts).marked.length, 0, "already sent images keep their run");
  const blocked = removeAttachment(sid, image.id, { ...opts, confirm: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.problems[0].code, "ATTACHMENT_IN_USE");
  assert.equal(listAttachments(sid, opts).length, 1);
  const runFile = join(run.dir, "run.json");
  const snapshot = JSON.parse(readFileSync(runFile, "utf8"));
  writeFileSync(runFile, JSON.stringify({ ...snapshot, status: "aborted" }));
  assert.equal(removeAttachment(sid, image.id, { ...opts, confirm: true }).removed, true);
  // a run that no longer exists does not block either
  const again = addAttachment(sid, makePng({ width: 4, height: 4 }), opts).attachment;
  markAttachmentsSent(sid, [again.id], "run-gone", opts);
  assert.equal(removeAttachment(sid, again.id, { ...opts, confirm: true }).removed, true);
  assert.ok(runDir(repoKey, "run-att", { env: box.env }).includes("run-att"));
});

test("readAttachmentBytes returns the stored bytes only while they match the recorded hash", () => {
  const { opts, id, dir } = fixture();
  const { attachment } = addAttachment(id, photo(), opts);
  const read = readAttachmentBytes(id, attachment, opts);
  assert.equal(read.ok, true);
  assert.equal(read.bytes.length, attachment.bytes);
  const file = join(dir, "attachments", `${attachment.sha256}.jpg`);
  const tampered = Buffer.from(read.bytes);
  tampered[tampered.length - 3] ^= 0xff;
  writeFileSync(file, tampered);
  assert.equal(readAttachmentBytes(id, attachment, opts).problems[0].code, "ATTACHMENT_CORRUPT");
  writeFileSync(file, Buffer.concat([read.bytes, Buffer.from("x")]));
  assert.equal(readAttachmentBytes(id, attachment, opts).problems[0].code, "ATTACHMENT_CORRUPT");
  assert.equal(readAttachmentBytes(id, { sha256: "0".repeat(64) }, opts).problems[0].code, "ATTACHMENT_NOT_FOUND");
});

test("session clean counts and removes attachments with the session record", async () => {
  const { opts, id, dir, userDir } = fixture();
  addAttachment(id, makePng(), opts);
  archiveSession(REPO, id, opts);
  const plan = cleanPlan(REPO, { userDir });
  assert.equal(plan.items.length, 1);
  assert.ok(plan.items[0].bytes > 0);
  const result = await cleanApply(plan, { userDir });
  assert.equal(result.removed.length, 1);
  assert.equal(existsSync(dir), false);
  assert.ok(repoSessionsDir(REPO, { userDir }));
});

test("claims: a run claims images before its first turn; pending skips live claims, honours stale ones and the claiming run's own", () => {
  const box = makeBox();
  const repoKey = box.repo.key;
  const sid = createSession({ repoKey, workspace: box.workspace, title: "claims" }, { userDir: box.userDir }).session.id;
  const opts = { userDir: box.userDir, repoKey, env: box.env };
  const image = addAttachment(sid, makePng(), opts).attachment;
  startRun(box, { runId: "run-claim" });
  assert.equal(pendingAttachments(sid, opts).length, 1);
  assert.deepEqual(claimAttachments(sid, [image.id], "run-claim", opts).claimed, [image.id]);
  assert.equal(listAttachments(sid, opts)[0].claimedRunId, "run-claim");
  assert.equal(pendingAttachments(sid, opts).length, 0, "claimed by an open run: not pending for another");
  assert.equal(pendingAttachments(sid, { ...opts, forRun: "run-claim" }).length, 1, "pending for the claiming run itself");
  const blocked = removeAttachment(sid, image.id, { ...opts, confirm: true });
  assert.equal(blocked.problems[0].code, "ATTACHMENT_IN_USE", "claimed but never sent still blocks the removal");
  // the claiming run is gone: the claim is stale, the image is pending again and removable
  const runFile = join(runDir(repoKey, "run-claim", { env: box.env }), "run.json");
  writeFileSync(runFile, JSON.stringify({ ...JSON.parse(readFileSync(runFile, "utf8")), status: "aborted" }));
  assert.equal(pendingAttachments(sid, opts).length, 1);
  assert.equal(removeAttachment(sid, image.id, { ...opts, confirm: true }).removed, true);
  assert.equal(claimAttachments(sid, [], "../bad", opts).problems[0].code, "RUN_ID_INVALID");
  assert.equal(markAttachmentsSent(sid, [], "../bad", opts).problems[0].code, "RUN_ID_INVALID");
});

test("a hostile run id in a record is dropped on load and never blocks a removal for good", () => {
  const { opts, id, dir } = fixture();
  const good = addAttachment(id, makePng(), opts).attachment;
  const raw = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
  raw.attachments = [{ ...good, sentRunId: "../../etc", claimedRunId: "a b" }];
  writeFileSync(join(dir, "session.json"), JSON.stringify(raw));
  const [loaded] = loadSession(REPO, id, { ...opts, repair: false }).session.attachments;
  assert.deepEqual([loaded.sentRunId, loaded.claimedRunId], [null, null]);
  assert.equal(removeAttachment(id, good.id, { ...opts, confirm: true }).removed, true);
});

test("Windows device namespaces and UNC paths are refused with a clear error, before any open", () => {
  const touched = [];
  const spy = { ...nodeFs, lstatSync: (...args) => { touched.push(args[0]); return nodeFs.lstatSync(...args); }, openSync: (...args) => { touched.push(args[0]); return nodeFs.openSync(...args); } };
  const B = String.fromCharCode(92);
  const paths = ["//./NUL", "//./pipe/x", "//?/C:/Windows/win.ini", "//server/share/a.png", "//./CON", "//?/C:/x.png"].map((p) => p.replaceAll("/", B)).concat(["//./CON", "//?/C:/x.png"]);
  for (const path of paths) {
    const result = readImageFile(path, { platform: "win32", fs: spy });
    assert.equal(result.ok, false, path);
    assert.equal(result.problems[0].code, "UNSAFE_PATH", path);
    assert.match(String(result.problems[0]), /UNSAFE_PATH: device paths/);
  }
  assert.deepEqual(touched, [], "nothing was opened or even stat-ed");
});

test("claimAttachments is compare-and-set: an image held by another OPEN run is skipped unless named; a closed holder is taken over", () => {
  const box = makeBox();
  const repoKey = box.repo.key;
  const sid = createSession({ repoKey, workspace: box.workspace, title: "cas" }, { userDir: box.userDir }).session.id;
  const opts = { userDir: box.userDir, repoKey, env: box.env };
  const image = addAttachment(sid, makePng(), opts).attachment;
  startRun(box, { runId: "runA" });
  assert.deepEqual(claimAttachments(sid, [image.id], "runA", opts).claimed, [image.id]);
  const second = claimAttachments(sid, [image.id], "runB", opts);
  assert.deepEqual(second.claimed, []);
  assert.deepEqual(second.skipped, [{ id: image.id, heldBy: "runA" }]);
  assert.equal(listAttachments(sid, opts)[0].claimedRunId, "runA", "the first claim stands");
  // explicitly named by the user: taken over
  assert.deepEqual(claimAttachments(sid, [image.id], "runB", { ...opts, explicit: [image.id] }).claimed, [image.id]);
  assert.equal(listAttachments(sid, opts)[0].claimedRunId, "runB");
  // a claim by a finished run is stale
  startRun(box, { runId: "runB" });
  const runFile = join(runDir(repoKey, "runB", { env: box.env }), "run.json");
  writeFileSync(runFile, JSON.stringify({ ...JSON.parse(readFileSync(runFile, "utf8")), status: "completed" }));
  assert.deepEqual(claimAttachments(sid, [image.id], "runC", opts).claimed, [image.id]);
  // an already sent image is skipped unless named
  markAttachmentsSent(sid, [image.id], "runC", opts);
  assert.equal(claimAttachments(sid, [image.id], "runD", opts).skipped.length, 1);
  assert.deepEqual(claimAttachments(sid, [image.id], "runD", { ...opts, explicit: [image.id] }).claimed, [image.id]);
  assert.equal(listAttachments(sid, opts)[0].sentRunId, null);
});

test("device and UNC paths are refused after realpath too: a symlink target and a junction in the parent directory", () => {
  const B = String.fromCharCode(92);
  const pipe = `${B}${B}.${B}pipe${B}x`;
  const files = tempDir("aw-att-link-");
  const target = join(files, "link.png");
  const viaLink = {
    ...nodeFs,
    lstatSync: () => ({ isFile: () => false, isSymbolicLink: () => true, size: 0 }),
    realpathSync: Object.assign(() => pipe, { native: () => pipe }),
  };
  const link = readImageFile(target, { platform: "win32", fs: viaLink });
  assert.equal(link.problems[0].code, "UNSAFE_PATH");
  let opened = 0;
  const viaParent = {
    ...nodeFs,
    realpathSync: Object.assign(() => "", { native: (p) => (p === files ? `${B}${B}?${B}GLOBALROOT${B}Device${B}x` : p) }),
    lstatSync: () => { opened += 1; return nodeFs.lstatSync(target, { throwIfNoEntry: false }); },
  };
  const junction = readImageFile(target, { platform: "win32", fs: viaParent });
  assert.equal(junction.problems[0].code, "UNSAFE_PATH");
  assert.equal(opened, 0, "refused before the file was even stat-ed");
  assert.equal(isDeviceOrUncPath(pipe) && isDeviceOrUncPath("//server/share/a.png") && !isDeviceOrUncPath("C:/images/a.png") && !isDeviceOrUncPath("/tmp/a.png"), true);
  // a normal local file is unaffected by the same checks
  writeFileSync(target, makePng());
  assert.equal(readImageFile(target, { platform: "win32" }).ok, true);
});
