// `session attach|detach|start --image|show` (handler called directly), real git repo, temp user directory.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { attachInspected, inspectAll, storeProblemError } from "../src/commands/images.mjs";
import { resolveRepo } from "../src/commands/run.mjs";
import { sessionCommand, sessionCommandMeta, sessionHelpText } from "../src/commands/session.mjs";
import { EXIT } from "../src/exit-codes.mjs";
import { listAttachments } from "../src/runtime/attachments.mjs";
import { sessionDir } from "../src/runtime/sessions.mjs";
import { cleanupTemp, fakeTerminal, git, tempDir, waitFor } from "./repo-fixture.mjs";
import { EXIF_GPS_TEXT, exifPayload, makeJpeg, makePng, makeWebp } from "./image-fixture.mjs";

after(cleanupTemp);

const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};

function world() {
  const userDir = tempDir("aw-ac-user-");
  const repo = tempDir("aw-ac-repo-");
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  const env = { ASTERWEAVE_CONFIG_DIR: userDir };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const files = tempDir("aw-ac-img-");
  const file = (name, bytes) => { writeFileSync(join(files, name), bytes); return join(files, name); };
  const call = async (args, { options = {}, argv, stdin, stdout } = {}) => {
    const out = stdout ?? sink();
    const err = sink();
    const ctx = { stdout: out, stderr: err, stdin: stdin ?? sink(), env, cwd: repo, positionals: args, options, ...(argv ? { argv } : {}) };
    let code;
    let error = null;
    try {
      code = await sessionCommand(ctx);
    } catch (e) {
      error = e;
      code = e.exitCode ?? 1;
    }
    const text = typeof out.text === "function" ? out.text() : "";
    return { code, out: text, error, json: () => JSON.parse(text) };
  };
  const start = async (extra = {}) => (await call(["start"], { options: { json: true }, ...extra })).json();
  return { userDir, repo, env, files, file, call, start, identity: () => resolveRepo({ cwd: repo, env }) };
}

test("meta and help: --image is accepted, attach and detach are documented with their JSON", () => {
  assert.ok(sessionCommandMeta.options.includes("image"));
  assert.match(sessionHelpText, /\n  attach /);
  assert.match(sessionHelpText, /\n  detach /);
  assert.match(sessionHelpText, /attach\s+\{ ok, sessionId, attachments/);
  assert.match(sessionHelpText, /--image path/);
});

test("session attach: stores stripped copies, prints what is stored, JSON has hashes and sizes only", async () => {
  const w = world();
  const { session } = await w.start();
  const photo = w.file("holiday.jpg", makeJpeg({ segments: [[0xe1, exifPayload()]] }));
  const shot = w.file("shot.png", makePng({ width: 5, height: 6 }));
  const text = await w.call(["attach", session.id, photo, shot]);
  assert.equal(text.code, EXIT.OK, text.error?.message);
  assert.match(text.out, /Attached 2 image\(s\)/);
  assert.match(text.out, /holiday\.jpg\s+jpeg/);
  assert.match(text.out, /stripped \(exif\)/);
  assert.match(text.out, /Nothing is sent until a run starts/);
  assert.equal(text.out.includes(EXIF_GPS_TEXT), false);

  const again = await w.call(["attach", session.id, photo], { options: { json: true } });
  const body = again.json();
  assert.equal(body.ok, true);
  assert.equal(body.duplicates.length, 1, "the same content is attached once");
  const [view] = body.attachments;
  assert.deepEqual(Object.keys(view).sort(), ["bytes", "dropped", "format", "height", "id", "metadataStripped", "mime", "name", "sentRunId", "sha256", "width"]);
  assert.equal(view.sha256.length, 64);
  assert.equal(JSON.stringify(body).includes(readFileSync(photo).toString("base64").slice(0, 40)), false);
  assert.equal(listAttachments(session.id, { userDir: w.userDir, env: w.env }).length, 2);
});

test("session attach: any invalid file refuses the whole command (exit 2) and nothing is stored", async () => {
  const w = world();
  const { session } = await w.start();
  const good = w.file("ok.png", makePng());
  const gif = w.file("anim.gif", Buffer.from("GIF89a\x01\0\x01\0\x80\0\0", "latin1"));
  const huge = w.file("huge.png", makePng({ width: 9000, height: 9000 }));
  const result = await w.call(["attach", session.id, good, gif, huge]);
  assert.equal(result.code, EXIT.USAGE);
  assert.equal(result.error.code, "IMAGE_INVALID");
  assert.match(result.error.message, /GIF/);
  assert.match(result.error.message, /8000/);
  assert.match(result.error.remediation, /PNG, JPEG or WebP/);
  assert.deepEqual(listAttachments(session.id, { userDir: w.userDir, env: w.env }), []);
  assert.equal((await w.call(["attach", session.id, join(w.files, "missing.png")])).code, EXIT.USAGE);
  assert.equal((await w.call(["attach", session.id])).code, EXIT.USAGE);
  assert.equal((await w.call(["attach"])).code, EXIT.USAGE);
  assert.equal((await w.call(["attach", session.id, good], { options: { title: "x" } })).code, EXIT.USAGE);
  const many = Array.from({ length: 11 }, (_, n) => w.file(`m${n}.png`, makePng({ width: n + 1, height: 1 })));
  assert.equal((await w.call(["attach", session.id, ...many])).code, EXIT.USAGE);
});

test("session attach: unknown and archived sessions are errors (exit 1)", async () => {
  const w = world();
  const img = w.file("a.png", makePng());
  assert.equal((await w.call(["attach", "s_0000000000000000", img])).code, EXIT.ERROR);
  const { session } = await w.start();
  await w.call(["archive", session.id]);
  const result = await w.call(["attach", session.id, img]);
  assert.equal(result.code, EXIT.ERROR);
  assert.equal(result.error.code, "SESSION_ARCHIVED");
});

test("session start --image (repeatable): validates first, records the session, attaches", async () => {
  const w = world();
  const a = w.file("a.png", makePng({ width: 2, height: 2 }));
  const b = w.file("b.webp", makeWebp());
  const started = await w.call(["start"], { options: { json: true, image: a }, argv: ["start", "--json", "--image", a, "--image", b] });
  assert.equal(started.code, EXIT.OK, started.error?.message);
  const body = started.json();
  assert.equal(body.ok, true);
  assert.equal(body.attachments.length, 2);
  assert.equal(body.session.attachments.length, 2, "the returned session shows them");
  assert.deepEqual(body.attachments.map((item) => item.format).sort(), ["png", "webp"]);

  const text = await w.call(["start"], { options: { image: a }, argv: ["start", `--image=${a}`] });
  assert.equal(text.code, EXIT.OK);
  assert.match(text.out, /Attachments \(1\)/);
  assert.match(text.out, /nothing is sent until a run starts/);

  const sessionsBefore = (await w.call(["list"], { options: { json: true } })).json().sessions.length;
  const bad = await w.call(["start"], { options: { image: join(w.files, "nope.png") }, argv: ["start", "--image", join(w.files, "nope.png")] });
  assert.equal(bad.code, EXIT.USAGE);
  assert.equal((await w.call(["list"], { options: { json: true } })).json().sessions.length, sessionsBefore, "no session is created for a refused image");
  assert.equal((await w.call(["start"], { options: { image: true }, argv: ["start", "--image"] })).code, EXIT.USAGE);
});

test("session show: text and JSON list attachments without bytes; older records show none", async () => {
  const w = world();
  const { session } = await w.start();
  const empty = await w.call(["show", session.id]);
  assert.match(empty.out, /Attachments \(0\)/);
  const jpg = w.file("p.jpg", makeJpeg({ segments: [[0xe1, exifPayload()]] }));
  await w.call(["attach", session.id, jpg]);
  const text = await w.call(["show", session.id]);
  assert.match(text.out, /Attachments \(1\)/);
  assert.match(text.out, /p\.jpg\s+jpeg/);
  assert.match(text.out, /not sent yet/);
  const shown = (await w.call(["show", session.id], { options: { json: true } })).json();
  assert.equal(shown.session.attachments.length, 1);
  assert.equal(shown.session.attachments[0].sha256.length, 64);
  assert.equal(JSON.stringify(shown).includes("GPSLatitude"), false);
});

test("session detach: needs --yes without a terminal, previews, removes only that copy; ids are validated", async () => {
  const w = world();
  const { session } = await w.start();
  await w.call(["attach", session.id, w.file("a.png", makePng({ width: 2, height: 2 })), w.file("b.png", makePng({ width: 3, height: 3 }))]);
  const [first, second] = listAttachments(session.id, { userDir: w.userDir, env: w.env });
  const dir = sessionDir((await w.identity()).key, session.id, { userDir: w.userDir });

  const preview = await w.call(["detach", session.id, first.id]);
  assert.equal(preview.code, EXIT.USAGE);
  assert.match(preview.out, /Pass --yes to detach/);
  const previewJson = await w.call(["detach", session.id, first.id], { options: { json: true } });
  assert.equal(previewJson.code, EXIT.USAGE);
  assert.equal(previewJson.json().ok, false);
  assert.equal(listAttachments(session.id, { userDir: w.userDir, env: w.env }).length, 2, "nothing removed without --yes");

  const done = await w.call(["detach", session.id, first.id], { options: { yes: true, json: true } });
  assert.equal(done.code, EXIT.OK, done.error?.message);
  assert.equal(done.json().removed, true);
  assert.deepEqual(listAttachments(session.id, { userDir: w.userDir, env: w.env }).map((item) => item.id), [second.id]);
  assert.deepEqual(readdirSync(join(dir, "attachments")), [`${second.sha256}.png`]);

  assert.equal((await w.call(["detach", session.id, "../../x"], { options: { yes: true } })).code, EXIT.USAGE);
  assert.equal((await w.call(["detach", session.id, first.id], { options: { yes: true } })).code, EXIT.ERROR, "already gone");
  assert.equal((await w.call(["detach", session.id])).code, EXIT.USAGE);
});

test("session detach on a terminal asks y/N: n keeps it, y removes it", async () => {
  for (const [key, removed] of [["n", false], ["y", true]]) {
    const w = world();
    const { session } = await w.start();
    await w.call(["attach", session.id, w.file("a.png", makePng())]);
    const [item] = listAttachments(session.id, { userDir: w.userDir, env: w.env });
    const terminal = fakeTerminal({ tty: true });
    const pending = w.call(["detach", session.id, item.id], { stdin: terminal.stdin, stdout: terminal.stdout });
    await waitFor(() => terminal.text().includes("[y/N]"), { label: "the y/N prompt" });
    terminal.stdin.write(key);
    const result = await pending;
    assert.equal(result.code, 0, result.error?.message);
    assert.equal(listAttachments(session.id, { userDir: w.userDir, env: w.env }).length, removed ? 0 : 1, key);
    assert.match(terminal.text(), /original file is not touched/);
  }
});

test("attachments live under the user directory only; the repository stays untouched", async () => {
  const w = world();
  const { session } = await w.start();
  await w.call(["attach", session.id, w.file("a.png", makePng())]);
  const dir = sessionDir((await w.identity()).key, session.id, { userDir: w.userDir });
  assert.equal(existsSync(join(dir, "attachments")), true);
  assert.equal(git(w.repo, "status", "--porcelain").trim(), "");
});

// --- partial failures: ONE document, all or nothing, exit codes ---------------------------------------

async function viaCli(w, argv) {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: { write: (text) => { out += text; } }, stderr: { write: (text) => { err += text; } }, env: w.env, cwd: w.repo, stdin: { isTTY: false } });
  return { code, out, err };
}

test("session attach --json that fails midway prints exactly ONE JSON document (the error), exit 2 for TOO_MANY, and stores nothing", async () => {
  const w = world();
  const { session } = await w.start();
  const images = Array.from({ length: 21 }, (_, n) => w.file(`i${n + 1}.png`, makePng({ width: n + 1, height: 1 })));
  for (let n = 0; n < 2; n += 1) assert.equal((await viaCli(w, ["session", "attach", session.id, ...images.slice(n * 10, n * 10 + 10), "--json"])).code, 0);
  const failed = await viaCli(w, ["session", "attach", session.id, images[0], images[20], "--json"]);
  assert.equal(failed.code, EXIT.USAGE);
  const body = JSON.parse(failed.out); // throws if there are two documents
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "TOO_MANY");
  assert.equal(listAttachments(session.id, { userDir: w.userDir, env: w.env }).length, 20);
  const text = await viaCli(w, ["session", "attach", session.id, images[20]]);
  assert.equal(text.code, EXIT.USAGE);
  assert.equal(text.out.includes("Attached"), false, "no success report before the error");
});

test("store problems other than TOO_MANY and bad ids exit 1 (archived session), as ONE JSON document", async () => {
  const w = world();
  const { session } = await w.start();
  await w.call(["archive", session.id]);
  const result = await viaCli(w, ["session", "attach", session.id, w.file("a.png", makePng()), "--json"]);
  assert.equal(result.code, EXIT.ERROR);
  assert.equal(JSON.parse(result.out).error.code, "SESSION_ARCHIVED");
  assert.deepEqual([storeProblemError({ code: "TOO_MANY", message: "x" }).exitCode, storeProblemError({ code: "ATTACHMENT_ID_INVALID", message: "x" }).exitCode, storeProblemError({ code: "SESSION_ARCHIVED", message: "x" }).exitCode, storeProblemError({ code: "UNREADABLE", message: "x" }).exitCode], [2, 2, 1, 1]);
});

test("attachInspected is all or nothing: copies stored by the same call are rolled back when a later file fails", async () => {
  const w = world();
  const { session } = await w.start();
  const opts = { userDir: w.userDir, env: w.env };
  const seeded = Array.from({ length: 19 }, (_, n) => w.file(`s${n + 1}.png`, makePng({ width: n + 1, height: 2 })));
  assert.equal((await w.call(["attach", session.id, ...seeded.slice(0, 10)])).code, 0);
  assert.equal((await w.call(["attach", session.id, ...seeded.slice(10)])).code, 0);
  assert.equal(listAttachments(session.id, opts).length, 19);
  const ctx = { env: w.env, cwd: w.repo };
  const inspected = inspectAll([w.file("n1.png", makePng({ width: 50, height: 3 })), w.file("n2.png", makePng({ width: 51, height: 3 }))], ctx);
  const result = attachInspected(session.id, inspected, ctx, (await w.identity()).key);
  assert.equal(result.problem.code, "TOO_MANY");
  assert.deepEqual(result.attachments, []);
  assert.equal(listAttachments(session.id, opts).length, 19, "n1 was stored and then rolled back");
  const dir = sessionDir((await w.identity()).key, session.id, { userDir: w.userDir });
  assert.equal(readdirSync(join(dir, "attachments")).length, 19, "its stored copy is gone too");
});
