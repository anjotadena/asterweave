// M3: the opt-in, read-only Claude Code transcript import (`asterweave memory import claude`).
// Synthetic transcripts only, in a temp HOME: no test ever reads the real ~/.claude.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { resolveRepo } from "../src/commands/run.mjs";
import { CLAUDE_FORMAT, claudeHomeDir, discoverProjectDirs, eventsFromMessage, IMPORT_MAX_BYTES, importClaude, parseClaudeLine, slugFor, versionKnown } from "../src/runtime/memory/claude-import.mjs";
import { addDays, openMemory } from "../src/runtime/memory/db.mjs";
import { localOwner } from "../src/runtime/memory/sessions.mjs";
import { cleanupAll, DAY, git, makeClock, rawBytes, sink, T0, tempDir, track } from "./memory-fixture.mjs";

after(cleanupAll);

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const daysAgo = (n) => new Date(Date.parse(T0) - n * DAY).toISOString();

function makeRepo(prefix) {
  const dir = join(tempDir(prefix), "widgets"); // the same folder NAME for every repository on purpose
  mkdirSync(dir);
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial", "--date=2025-01-01T00:00:00Z"); // older than every fixture transcript (the import cutoff is the first commit)
  return dir;
}

async function world({ enabled = true } = {}) {
  const home = tempDir("aw-imp-home-");
  const userDir = tempDir("aw-imp-user-");
  const repo = makeRepo("aw-imp-a-");
  const env = { ASTERWEAVE_CONFIG_DIR: userDir, HOME: home, USERPROFILE: home };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (enabled) writeFileSync(join(userDir, "config.json"), JSON.stringify({ memory: { claudeImportEnabled: true } }));
  const now = makeClock(T0);
  const { workspace } = await resolveRepo({ cwd: repo, env });
  const projects = join(home, ".claude", "projects");
  const w = { home, userDir, repo, env, now, workspace, projects };
  w.cli = async (argv, cwd = repo) => {
    const out = sink();
    const err = sink();
    const code = await runCli(["memory", ...argv], { stdout: out, stderr: err, stdin: { isTTY: false }, env, cwd, now });
    return { code, out: out.text(), err: err.text(), json: () => JSON.parse(out.text()) };
  };
  w.importJson = async (...flags) => {
    const r = await w.cli(["import", "claude", "--json", ...flags]);
    assert.equal(r.code, 0, r.err + r.out);
    return r.json().import;
  };
  w.dir = (root) => {
    const dir = join(projects, slugFor(root));
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  w.db = (work) => {
    const mem = track(openMemory({ userDir, now }));
    try {
      return work(mem);
    } finally {
      mem.close();
    }
  };
  let n = 0;
  w.rec = (extra = {}) => {
    n += 1;
    return JSON.stringify({ parentUuid: null, isSidechain: false, userType: "external", cwd: workspace, sessionId: "5e55-0001", version: "2.1.322", gitBranch: "main", type: "user", message: { role: "user", content: `step ${n}` }, uuid: `aaaa-${String(n).padStart(4, "0")}`, timestamp: daysAgo(1), ...extra });
  };
  return w;
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[full] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

// --- the parser ----------------------------------------------------------------------------------------------------------

test("parser: slug rule, whitelist, never-import types, thinking dropped, versions, deterministic ids", () => {
  assert.equal(slugFor("C:\\Users\\Anjo\\Projects\\asterweave"), "C--Users-Anjo-Projects-asterweave");
  assert.equal(slugFor("/home/a/my.repo"), "-home-a-my-repo");
  assert.equal(claudeHomeDir({ env: { HOME: "/h" }, platform: "linux" }), "/h/.claude");
  assert.equal(claudeHomeDir({ env: { USERPROFILE: "C:\\U", CLAUDE_CONFIG_DIR: "C:\\c" }, platform: "win32" }), "C:\\c");
  for (const type of [...CLAUDE_FORMAT.neverImport, "queue-operation", "ai-title", "brand-new-type"]) {
    const parsed = parseClaudeLine(JSON.stringify({ type, uuid: "a1b2c3d4", sessionId: "e5f6a7b8", timestamp: T0, message: { content: "x" } }));
    assert.deepEqual([parsed.kind, parsed.reason], ["skip", "unsupported-type"], type);
  }
  assert.deepEqual(parseClaudeLine("{oops"), { kind: "malformed", reason: "json" });
  assert.equal(parseClaudeLine("[1]").kind, "malformed");
  assert.equal(parseClaudeLine(JSON.stringify({ type: "user", isMeta: true, uuid: "a1b2c3d4", sessionId: "e5f6a7b8", timestamp: T0, message: { content: "x" } })).reason, "meta");
  const side = { type: "assistant", isSidechain: true, uuid: "a1b2c3d4", sessionId: "e5f6a7b8", timestamp: T0, message: { content: "x" } };
  assert.equal(parseClaudeLine(JSON.stringify(side)).reason, "sidechain");
  assert.equal(parseClaudeLine(JSON.stringify(side), { includeSidechains: true }).kind, "message");
  assert.equal(parseClaudeLine(JSON.stringify({ type: "user", uuid: "a1b2c3d4", sessionId: "e5f6a7b8", message: { content: "x" } })).reason, "no-timestamp", "no source time: never stored as new");
  assert.equal(parseClaudeLine(JSON.stringify({ type: "assistant", uuid: "a1b2c3d4", sessionId: "e5f6a7b8", timestamp: T0, message: { content: [{ type: "thinking", thinking: "secret plan" }] } })).reason, "hidden-reasoning");

  const msg = parseClaudeLine(JSON.stringify({ type: "assistant", version: "2.1.322", uuid: "a1b2c3d5", sessionId: "e5f6a7b9", timestamp: T0, cwd: "/r", message: { model: "claude-x", content: [{ type: "thinking", thinking: "THINK" }, { type: "text", text: "Reading" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.js" } }] } }));
  assert.equal(msg.kind, "message");
  assert.equal(msg.hiddenBlocks, 1);
  assert.equal(msg.versionKnown, true);
  const events = eventsFromMessage(msg);
  assert.deepEqual(events.map((e) => [e.id, e.type, e.role, e.toolCallId ?? null]), [["claude:e5f6a7b9:a1b2c3d5", "message", "assistant", null], ["claude:e5f6a7b9:a1b2c3d5:1", "tool_call", "assistant", "toolu_1"]]);
  assert.ok(!events.some((e) => e.content.includes("THINK")));
  assert.deepEqual(eventsFromMessage(msg).map((e) => e.id), events.map((e) => e.id), "ids are deterministic");
  assert.equal(versionKnown("9.0.0"), false);
  assert.equal(versionKnown(undefined), false);
  assert.equal(versionKnown("2.1.165"), true);
});

// --- opt-in --------------------------------------------------------------------------------------------------------------

test("import is opt-in: refused by default (also --dry-run), with remediation; status says disabled", async () => {
  const w = await world({ enabled: false });
  writeFileSync(join(w.dir(w.workspace), "s.jsonl"), `${w.rec()}\n`);
  for (const flags of [[], ["--dry-run"]]) {
    const r = await w.cli(["import", "claude", "--json", ...flags]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.out || r.err);
    assert.equal(body.error.code, "MEMORY_IMPORT_DISABLED");
    assert.match(body.error.remediation, /claudeImportEnabled/);
  }
  assert.equal(existsSync(join(w.userDir, "memory", "memory.db")), false, "nothing was created");
  const status = (await w.cli(["status", "--json"])).json().memory;
  assert.deepEqual(status.import.claude, { enabled: false, lastImportAt: null, files: 0 });
  assert.equal((await w.cli(["import"])).code, 2, "a source is required");
  assert.equal((await w.cli(["import", "codex"])).code, 2, "claude is the only source");
});

// --- the main flow -------------------------------------------------------------------------------------------------------

test("only this repository's transcripts import; filtering, redaction, pairing, read-only and idempotent re-run", async () => {
  const w = await world();
  const other = makeRepo("aw-imp-b-");
  const { workspace: otherWs } = await resolveRepo({ cwd: other, env: w.env });
  const wtRoot = join(tempDir("aw-imp-wt-"), "wt");
  git(w.repo, "worktree", "add", "-b", "side", wtRoot);
  const { workspace: wtWs } = await resolveRepo({ cwd: wtRoot, env: w.env });

  const main = [
    w.rec({ uuid: "ac-000001", message: { role: "user", content: `Fix the login bug in the session handler\nmore detail ${SECRET}` }, timestamp: daysAgo(10) }),
    w.rec({ uuid: "ac-000002", type: "assistant", message: { role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "THINK_MARKER" }, { type: "text", text: "Looking at it" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.js" } }] } }),
    w.rec({ uuid: "ac-000003", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }] } }),
    JSON.stringify({ type: "api-request", uuid: "ac-000004", body: "APIREQ_MARKER", sessionId: "5e55-0001", timestamp: daysAgo(1) }),
    JSON.stringify({ type: "file-history-snapshot", messageId: "m", snapshot: { files: "SNAPSHOT_MARKER" } }),
    JSON.stringify({ type: "attachment", uuid: "ac-000006", content: "ATTACH_MARKER", sessionId: "5e55-0001", timestamp: daysAgo(1) }),
    JSON.stringify({ type: "future-thing", uuid: "ac-000007", data: "FUTURE_MARKER" }),
    w.rec({ uuid: "ac-000008", isMeta: true, message: { role: "user", content: "META_MARKER" } }),
    w.rec({ uuid: "ac-000009", type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "SIDECHAIN_MARKER" }] } }),
    w.rec({ uuid: "ac-000010", cwd: otherWs, message: { role: "user", content: "OTHER_REPO_MARKER" } }),
    "{not json at all",
    w.rec({ uuid: "ac-000012", type: "assistant", version: "9.0.0", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
    w.rec({ uuid: "ac-000013", message: { role: "user", content: "EXPIRED_MARKER" }, timestamp: daysAgo(400) }),
  ];
  writeFileSync(join(w.dir(w.workspace), "5e55-0001.jsonl"), `${main.join("\n")}\n`);
  writeFileSync(join(w.dir(wtWs), "5e55-0002.jsonl"), `${w.rec({ uuid: "bc-000001", sessionId: "5e55-0002", cwd: wtWs, gitBranch: "side", message: { role: "user", content: "worktree turn" } })}\n`);
  // Another repository with the same folder name: a different slug, never even opened.
  writeFileSync(join(w.dir(otherWs), "5e55-0003.jsonl"), `${w.rec({ uuid: "dc-000001", sessionId: "5e55-0003", cwd: otherWs, message: { role: "user", content: "OTHER_DIR_MARKER" } })}\n`);
  // A directory whose name extends this slug but whose records belong elsewhere: opened, rejected per record.
  mkdirSync(join(w.projects, `${slugFor(w.workspace)}-old`), { recursive: true });
  writeFileSync(join(w.projects, `${slugFor(w.workspace)}-old`, "5e55-0004.jsonl"), `${w.rec({ uuid: "cc-000001", sessionId: "5e55-0004", cwd: `${w.workspace}-old`, message: { role: "user", content: "COLLISION_MARKER" } })}\n`);
  const before = snapshot(join(w.home, ".claude"));

  const dry = await w.importJson("--dry-run");
  assert.equal(dry.dryRun, true);
  assert.equal(dry.events, 6, "5 from the main transcript (user text, assistant text + tool call, tool result, the 9.0.0 line) + 1 from the worktree");
  assert.equal(dry.sessions, 2);
  assert.deepEqual(
    [dry.skipped["unsupported-type"], dry.skipped.meta, dry.skipped.sidechain, dry.skipped["other-repo"], dry.skipped.malformed, dry.skipped.expired, dry.skipped["hidden-reasoning"]],
    [4, 1, 1, 2, 1, 1, 1],
  );
  assert.deepEqual(dry.formatWarnings.map((x) => [x.version, x.lines]), [["9.0.0", 1]]);
  assert.equal(existsSync(join(w.userDir, "memory", "memory.db")), false, "a dry run writes nothing");
  assert.equal((await w.importJson("--dry-run", "--include-sidechains")).events, 7, "--include-sidechains adds the subagent turn");
  const text = (await w.cli(["import", "claude", "--dry-run"])).out;
  assert.match(text, /Would import 6 event\(s\) in 2 session\(s\)/);
  assert.match(text, /other repository 2/);
  assert.match(text, /Warning: .*9\.0\.0/);

  const done = await w.importJson();
  assert.deepEqual([done.events, done.sessions, done.errors.length], [6, 2, 0]);
  w.db((mem) => {
    const raw = rawBytes(mem);
    for (const marker of ["THINK_MARKER", "APIREQ_MARKER", "SNAPSHOT_MARKER", "ATTACH_MARKER", "FUTURE_MARKER", "META_MARKER", "SIDECHAIN_MARKER", "OTHER_REPO_MARKER", "OTHER_DIR_MARKER", "COLLISION_MARKER", "EXPIRED_MARKER", SECRET]) {
      assert.ok(!raw.includes(marker), `${marker} is not stored`);
    }
    const events = mem.db.prepare("SELECT id, type, role, content, tool_call_id, event_time, expires_at, session_id FROM events ORDER BY session_id, seq").all();
    assert.equal(events.length, 6);
    const first = events.find((e) => e.id === "claude:5e55-0001:ac-000001");
    assert.match(first.content, /Fix the login bug/);
    assert.ok(!first.content.includes(SECRET), "redacted before persistence");
    assert.equal(first.event_time, daysAgo(10));
    assert.equal(first.expires_at, addDays(daysAgo(10), 365), "expiry runs from the source time");
    const call = events.find((e) => e.type === "tool_call");
    const result = events.find((e) => e.type === "tool_result");
    assert.deepEqual([call.tool_call_id, result.tool_call_id, result.role], ["toolu_1", "toolu_1", "tool"]);
    assert.deepEqual(events.filter((e) => e.session_id === first.session_id).map((e) => e.id), ["claude:5e55-0001:ac-000001", "claude:5e55-0001:ac-000002", "claude:5e55-0001:ac-000002:1", "claude:5e55-0001:ac-000003", "claude:5e55-0001:ac-000012"], "file order");
    const session = mem.db.prepare("SELECT * FROM sessions WHERE id = ?").get(first.session_id);
    assert.deepEqual([session.external_session_id, session.visibility, session.owner, session.title, session.branch], ["claude:5e55-0001", "private", localOwner(mem), "Fix the login bug in the session handler", "main"]);
    assert.equal(mem.db.prepare("SELECT branch FROM sessions WHERE external_session_id = 'claude:5e55-0002'").get().branch, "side");
  });

  const again = await w.importJson();
  assert.equal(again.events, 0, "idempotent re-run");
  assert.ok(again.files.every((f) => f.unchanged));
  assert.deepEqual(snapshot(join(w.home, ".claude")), before, "Claude's files are byte-identical and nothing was added");

  const status = (await w.cli(["status", "--json"])).json().memory;
  assert.equal(status.import.claude.enabled, true);
  assert.equal(status.import.claude.lastImportAt, T0);
  assert.equal(status.import.claude.files, 3);
  assert.match((await w.cli(["status"])).out, /Import     Claude Code enabled; last import 2026-11-11/);

  // Forgotten data never comes back, even when the whole file is rescanned.
  assert.equal((await w.cli(["forget", "claude:5e55-0001:ac-000001", "--yes"])).code, 0);
  w.db((mem) => mem.db.prepare("DELETE FROM claude_import_files").run());
  const replay = await w.importJson();
  assert.deepEqual([replay.events, replay.skipped.tombstoned, replay.skipped["already-imported"]], [0, 1, 5]);
  const sessionId = w.db((mem) => mem.db.prepare("SELECT session_id FROM events WHERE id = 'claude:5e55-0001:ac-000003'").get().session_id);
  assert.equal((await w.cli(["forget", sessionId, "--yes"])).code, 0);
  w.db((mem) => mem.db.prepare("DELETE FROM claude_import_files").run());
  const replay2 = await w.importJson();
  assert.equal(replay2.events, 0);
  assert.equal(replay2.skipped.tombstoned, 5, "every event of a forgotten session is refused");
  w.db((mem) => assert.equal(mem.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(sessionId).n, 0, "the session is not recreated"));
  assert.deepEqual(snapshot(join(w.home, ".claude")), before);
});

// --- incremental reading ---------------------------------------------------------------------------------------------------

test("append, torn last line, malformed line, truncation and rotation: incremental and duplicate-free", async () => {
  const w = await world();
  const file = join(w.dir(w.workspace), "5e55-0001.jsonl");
  const r = Array.from({ length: 7 }, () => w.rec());
  r[0] = w.rec({ uuid: "aaaa-ffff", message: { role: "user", content: `${"x".repeat(60)} ${SECRET} tail` } });
  writeFileSync(file, `${r[0]}\n${r[1]}\n`);
  assert.equal((await w.importJson()).events, 2);
  w.db((mem) => {
    const { title } = mem.db.prepare("SELECT title FROM sessions").get();
    assert.ok(title.length <= 80 && title.startsWith("xxx"), title);
    assert.ok(!title.includes(SECRET.slice(0, 12)) && !rawBytes(mem).includes(SECRET.slice(0, 12)), "the title is redacted before it is cut");
  });

  appendFileSync(file, `${r[2]}\n${r[3].slice(0, 25)}`);
  const torn = await w.importJson();
  assert.deepEqual([torn.events, torn.files[0].tornLine, torn.skipped.malformed], [1, true, 0], "a torn line is neither imported nor malformed");
  const mark = w.db((mem) => mem.db.prepare("SELECT offset, size FROM claude_import_files").get());
  assert.equal(Number(mark.offset), Buffer.byteLength(`${r[0]}\n${r[1]}\n${r[2]}\n`), "the watermark stays before the torn line");

  appendFileSync(file, `${r[3].slice(25)}\n`);
  assert.equal((await w.importJson()).events, 1, "the completed line imports once");

  appendFileSync(file, `garbage{\n${r[4]}\n`);
  const bad = await w.importJson();
  assert.deepEqual([bad.events, bad.skipped.malformed, bad.files[0].malformed], [1, 1, 1]);
  assert.match((await w.cli(["import", "claude"])).out, /Imported 0 event/);

  writeFileSync(file, `${r[0]}\n${r[5]}\n`); // truncated and rewritten: smaller than the watermark
  const shrank = await w.importJson();
  assert.deepEqual([shrank.events, shrank.files[0].rescanned, shrank.skipped["already-imported"]], [1, "shrank", 1]);

  writeFileSync(file, `${r[6]}\n${r[0]}\n${r[5]}\n`); // rotated: larger, but the watermark line moved
  const moved = await w.importJson();
  assert.deepEqual([moved.events, moved.files[0].rescanned, moved.skipped["already-imported"]], [1, "watermark-moved", 2]);

  w.db((mem) => {
    const ids = mem.db.prepare("SELECT id FROM events").all().map((e) => e.id);
    assert.equal(ids.length, 7);
    assert.equal(new Set(ids).size, 7, "no duplicates");
  });
  assert.ok(statSync(file).size > 0);
});

// --- nested transcripts, the long-slug hint, the read budget ------------------------------------------------------------

test("nested transcripts: read only with --include-sidechains, per-record check, depth limit, own watermarks", async () => {
  const w = await world();
  const other = makeRepo("aw-imp-n-");
  const { workspace: otherWs } = await resolveRepo({ cwd: other, env: w.env });
  const dir = w.dir(w.workspace);
  const side = (uuid, text, extra = {}) => w.rec({ uuid, type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
  writeFileSync(join(dir, "5e55-0001.jsonl"), `${w.rec({ uuid: "70b-000001", message: { role: "user", content: "Main transcript first" } })}\n`);
  const sub = join(dir, "5e55-0001", "subagents");
  mkdirSync(sub, { recursive: true });
  const agentFile = join(sub, "agent-a.jsonl");
  writeFileSync(agentFile, `${side("5ab-000001", "subagent turn")}\n${side("5ab-000002", "NESTED_OTHER_MARKER", { cwd: otherWs })}\n`);
  const level3 = join(dir, "a", "b", "c");
  mkdirSync(join(level3, "d"), { recursive: true });
  writeFileSync(join(level3, "deep.jsonl"), `${side("dee-000003", "three levels down")}\n`);
  writeFileSync(join(level3, "d", "too-deep.jsonl"), `${side("dee-000004", "TOO_DEEP_MARKER")}\n`);
  const before = snapshot(join(w.home, ".claude"));

  const plain = await w.importJson("--dry-run");
  assert.deepEqual([plain.events, plain.files.length, plain.dirs[0].nested], [1, 1, 0], "without --include-sidechains nested files are not read");
  const done = await w.importJson("--include-sidechains");
  assert.deepEqual([done.events, done.dirs[0].nested, done.skipped["other-repo"], done.errors.length], [3, 2, 1, 0]);
  assert.deepEqual(done.files.map((x) => x.file), [join(dir, "5e55-0001.jsonl"), agentFile, join(level3, "deep.jsonl")], "top level first, then nested, at most 3 levels down");
  assert.deepEqual(snapshot(join(w.home, ".claude")), before, "Claude's files are byte-identical");
  w.db((mem) => {
    const ids = mem.db.prepare("SELECT id FROM events").all().map((e) => e.id).sort();
    assert.deepEqual(ids, ["claude:5e55-0001:dee-000003", "claude:5e55-0001:5ab-000001", "claude:5e55-0001:70b-000001"].sort());
    const raw = rawBytes(mem);
    for (const marker of ["NESTED_OTHER_MARKER", "TOO_DEEP_MARKER"]) assert.ok(!raw.includes(marker), `${marker} is not stored`);
    assert.equal(mem.db.prepare("SELECT title FROM sessions").get().title, "Main transcript first", "the main transcript opens the session");
    const rows = mem.db.prepare("SELECT path, repo_id FROM claude_import_files").all();
    const repoId = rows[0].repo_id;
    const key = (p) => `${repoId}|${process.platform === "win32" ? p.toLowerCase() : p}`;
    assert.deepEqual(rows.map((r) => r.path).sort(), [join(dir, "5e55-0001.jsonl"), agentFile, join(level3, "deep.jsonl")].map(key).sort(), "one watermark row per file, keyed by repository and full path");
    assert.ok(rows.every((r) => r.repo_id === repoId));
  });
  appendFileSync(agentFile, `${side("5ab-000005", "appended later")}\n`);
  const again = await w.importJson("--include-sidechains");
  assert.deepEqual([again.events, again.files.filter((x) => x.unchanged).length], [1, 2], "a nested file is incremental too");
  assert.equal((await w.importJson()).events, 0, "without the flag the nested files are left alone");
});

test("long-slug hint: a prefix match is discovery only; each record is still checked", async () => {
  // The default constant, against a fake directory listing (no long paths on disk).
  const longRoot = `/home/u/${"deep-folder/".repeat(25)}widgets`;
  const slug = slugFor(longRoot);
  assert.ok(slug.length > CLAUDE_FORMAT.longSlugPrefix);
  const prefix = slug.slice(0, CLAUDE_FORMAT.longSlugPrefix);
  const dirent = (name, kind = "dir") => ({ name, isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link", isFile: () => kind === "file" });
  const fakeFs = { readdirSync: () => [dirent(`${prefix}-1a2b3c`), dirent(`${prefix}-link`, "link"), dirent(`${prefix}-file`, "file"), dirent("-home-u-widgets2"), dirent("-home-u-other")] };
  const found = discoverProjectDirs("/c", [longRoot], { fs: fakeFs, platform: "linux" });
  const expected = join("/c", "projects", `${prefix}-1a2b3c`);
  assert.deepEqual([found.dirs, found.hinted, found.symlinks], [[expected], [expected], 1]);
  const short = discoverProjectDirs("/c", ["/home/u/widgets"], { fs: fakeFs, platform: "linux" });
  assert.deepEqual([short.dirs, short.hinted], [[], []], "a slug within the limit gets no prefix hint");

  // End to end on disk, with a shorter prefix so the paths stay short.
  const w = await world();
  const other = makeRepo("aw-imp-l-");
  const { workspace: otherWs } = await resolveRepo({ cwd: other, env: w.env });
  const n = slugFor(w.workspace).length - 3;
  const mine = join(w.projects, `${slugFor(w.workspace).slice(0, n)}-h4sh01`);
  const theirs = join(w.projects, `${slugFor(w.workspace).slice(0, n)}-h4sh02`);
  mkdirSync(mine, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  writeFileSync(join(mine, "5e55-0001.jsonl"), `${w.rec({ uuid: "10e-000001" })}\n`);
  writeFileSync(join(theirs, "5e55-0009.jsonl"), `${w.rec({ uuid: "10e-000002", sessionId: "5e55-0009", cwd: otherWs, message: { role: "user", content: "PREFIX_OTHER_MARKER" } })}\n`);
  const repo = await resolveRepo({ cwd: w.repo, env: w.env });
  const sameRepo = async (cwd) => isAbsolute(cwd) && (await resolveRepo({ cwd, env: w.env })).key === repo.key;
  const input = { mem: null, dryRun: true, now: w.now, claudeDir: join(w.home, ".claude"), roots: [w.workspace], sameRepo, repoId: null, owner: null };
  const hinted = await importClaude({ ...input, slugPrefixLength: n });
  assert.deepEqual(hinted.dirs.map((d) => [basename(d.dir), d.hint]), [[basename(mine), "long-slug-prefix"], [basename(theirs), "long-slug-prefix"]]);
  assert.deepEqual([hinted.events, hinted.sessions, hinted.skipped["other-repo"]], [1, 1, 1], "the prefix-sharing directory of another repository imports nothing");
  assert.equal((await importClaude(input)).dirs.length, 0, "with the default limit this short slug gets no hint");
});

test("--max-bytes: one budget across files, partial then complete on reruns, no duplicates; bad values exit 2", async () => {
  const w = await world();
  const dir = w.dir(w.workspace);
  const a = Array.from({ length: 6 }, () => w.rec());
  const big = w.rec({ sessionId: "5e55-0002", message: { role: "user", content: "word ".repeat(600) } });
  const b = [big, ...Array.from({ length: 4 }, () => w.rec({ sessionId: "5e55-0002" }))];
  writeFileSync(join(dir, "5e55-0001.jsonl"), `${a.join("\n")}\n`);
  writeFileSync(join(dir, "5e55-0002.jsonl"), `${b.join("\n")}\n`);
  const bigLine = Buffer.byteLength(big) + 1;
  assert.ok(bigLine > IMPORT_MAX_BYTES.min, "one line is larger than the smallest budget");

  const full = await w.importJson("--dry-run");
  const totalBytes = statSync(join(dir, "5e55-0001.jsonl")).size + statSync(join(dir, "5e55-0002.jsonl")).size;
  assert.deepEqual([full.events, full.partial, full.maxBytes, full.bytesRead], [11, false, IMPORT_MAX_BYTES.default, totalBytes]);
  const dryBounded = await w.importJson("--dry-run", "--max-bytes", "1024");
  assert.equal(dryBounded.partial, true);
  assert.ok(dryBounded.events < 11 && dryBounded.bytesRead <= 1024, "a dry run honours the budget");
  assert.match((await w.cli(["import", "claude", "--dry-run", "--max-bytes", "1024"])).out, /Stopped at the read budget \(1024 bytes/);

  const runs = [];
  for (let i = 0; i < 30; i += 1) {
    const r = await w.importJson("--max-bytes", "1024");
    runs.push(r);
    if (!r.partial) break;
  }
  assert.equal(runs.at(-1).partial, false, "reruns finish");
  assert.ok(runs.length >= 3, `several runs were needed (${runs.length})`);
  for (const r of runs.slice(0, -1)) {
    assert.ok(r.bytesRead > 0, "every partial run made progress");
    assert.ok(r.bytesRead <= 1024 || r.bytesRead === bigLine, `within the budget, or exactly one oversized line (${r.bytesRead})`);
    assert.equal(r.errors.length, 0, "partial is not an error");
  }
  assert.ok(runs.some((r) => r.bytesRead === bigLine), "an oversized line is consumed alone");
  assert.ok(runs.some((r) => r.files[0].events > 0 && r.files[1].partial), "the budget is shared: a run can finish one file and stop inside the next");
  assert.equal(runs.reduce((sum, r) => sum + r.events, 0), full.events, "the bounded runs add up to one unbounded run");
  assert.equal(runs.reduce((sum, r) => sum + r.bytesRead, 0), totalBytes, "every byte is read exactly once across the reruns");
  w.db((mem) => {
    const ids = mem.db.prepare("SELECT id FROM events").all().map((e) => e.id);
    assert.deepEqual([ids.length, new Set(ids).size], [11, 11], "no duplicates");
  });
  const settled = await w.importJson("--max-bytes", "1024");
  assert.deepEqual([settled.events, settled.partial, settled.files.every((x) => x.unchanged)], [0, false, true]);

  // A partial text run says to rerun and still exits 0.
  appendFileSync(join(dir, "5e55-0001.jsonl"), `${Array.from({ length: 6 }, () => w.rec()).join("\n")}\n`);
  const text = await w.cli(["import", "claude", "--max-bytes", "1024"]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /Rerun the import to continue/);

  for (const bad of ["0", "1023", "abc", "1k", "-5", "1.5", "+2048", " ", "4294967297", "99999999999"]) {
    const r = await w.cli(["import", "claude", "--max-bytes", bad]);
    assert.equal(r.code, 2, `--max-bytes ${bad}`);
    assert.match(r.err + r.out, /--max-bytes/, `the error names the option (${bad})`);
  }
  const missing = await w.cli(["import", "claude", "--max-bytes"]);
  assert.equal(missing.code, 2);
  assert.match(missing.err + missing.out, /--max-bytes/);
  assert.equal((await w.cli(["import", "claude", "--dry-run", "--max-bytes", String(IMPORT_MAX_BYTES.max)])).code, 0, "the upper bound is accepted");
});
