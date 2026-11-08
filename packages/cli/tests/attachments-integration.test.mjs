// The REAL attachment store behind the context/TUI views (Track C calls addAttachment/listAttachments with { repoKey, ...seams }).
// Temp user directory only. Checks the call shapes both sides rely on.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { contextCommand, createSessionViews } from "../src/commands/context.mjs";
import { resolveRepo } from "../src/commands/run.mjs";
import { addAttachment, listAttachments } from "../src/runtime/attachments.mjs";
import { createRunForGraph } from "../src/runtime/loop.mjs";
import { createSession } from "../src/runtime/sessions.mjs";
import { cleanupTemp, git, tempDir } from "./repo-fixture.mjs";
import { deliveryGraph } from "./loop-fixture.mjs";
import { EXIF_GPS_TEXT, exifPayload, makeJpeg, makePng } from "./image-fixture.mjs";

after(cleanupTemp);

const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};

async function world() {
  const userDir = tempDir("aw-int-user-");
  const repo = tempDir("aw-int-repo-");
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  const env = { ASTERWEAVE_CONFIG_DIR: userDir };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const identity = await resolveRepo({ cwd: repo, env });
  const session = createSession({ repoKey: identity.key, workspace: identity.workspace, title: "views" }, { env }).session;
  const files = tempDir("aw-int-img-");
  const file = (name, bytes) => { writeFileSync(join(files, name), bytes); return join(files, name); };
  return { userDir, repo, env, identity, session, file };
}

test("call shapes: addAttachment(sessionId, path, { repoKey, env }) and listAttachments(sessionId, { repoKey, env }) agree", async () => {
  const w = await world();
  const opts = { repoKey: w.identity.key, env: w.env };
  const added = addAttachment(w.session.id, w.file("shot.png", makePng({ width: 12, height: 8 })), opts);
  assert.equal(added.ok, true, JSON.stringify(added.problems));
  assert.deepEqual(added.problems, []);
  assert.equal(added.attachment.name, "shot.png");
  const listed = listAttachments(w.session.id, opts);
  assert.ok(Array.isArray(listed));
  assert.deepEqual(listed, [added.attachment]);
  // the same through only the environment (no repoKey): the session is found by id
  assert.deepEqual(listAttachments(w.session.id, { env: w.env }), listed);
  // a refusal has the shape the TUI renders: ok false, attachment null, problems that print as lines
  const refused = addAttachment(w.session.id, w.file("note.txt", "not an image"), opts);
  assert.equal(refused.ok, false);
  assert.equal(refused.attachment, null);
  assert.ok(refused.problems.length >= 1);
  assert.match(String(refused.problems[0]), /UNSUPPORTED_FORMAT: .*only PNG, JPEG and WebP/);
  assert.equal(String(refused.problems[0]).includes("[object"), false);
});

test("the TUI views (/image, /attachments) and `context --json` read the real store", async () => {
  const w = await world();
  const views = createSessionViews({ env: w.env }, { repoKey: w.identity.key });
  const photo = w.file("holiday.jpg", makeJpeg({ segments: [[0xe1, exifPayload()]] }));

  const staged = (await views.image(photo)).join("\n");
  assert.match(staged, /Staged on session/, staged);
  assert.match(staged, /holiday\.jpg/);
  assert.equal(staged.includes(EXIF_GPS_TEXT), false);

  const listed = (await views.attachments()).join("\n");
  assert.match(listed, /1 staged image/, listed);
  assert.match(listed, /holiday\.jpg/);

  const refused = (await views.image(w.file("x.gif", Buffer.from("GIF89a\x01\0\x01\0\x80\0\0", "latin1")))).join("\n");
  assert.match(refused, /Image not staged/);
  assert.match(refused, /GIF/);
  assert.equal(refused.includes("[object"), false);

  // `context --json` for the session shows the real attachment (count and bytes, no bytes of the image)
  createRunForGraph({ graph: deliveryGraph, goal: "g", repo: { key: w.identity.key, realpath: w.identity.workspace }, runId: "run-int", env: w.env });
  const out = sink();
  const code = await contextCommand({ stdout: out, stderr: sink(), stdin: sink(), env: w.env, cwd: w.repo, positionals: [], options: { json: true, session: w.session.id } });
  assert.equal(code, 0);
  const body = JSON.parse(out.text());
  assert.equal(body.ok, true);
  assert.equal(body.context.attachments.count, 1);
  assert.equal(JSON.stringify(body).includes(EXIF_GPS_TEXT), false);
  const [stored] = listAttachments(w.session.id, { repoKey: w.identity.key, env: w.env });
  assert.equal(body.context.attachments.bytes, stored.bytes);
});
