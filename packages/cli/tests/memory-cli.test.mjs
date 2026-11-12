// `asterweave memory ...` through runCli (real git repository, temp user directory, fake clock) and the memory.* configuration.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { resolveRepo } from "../src/commands/run.mjs";
import { coerceValue, ConfigError, ENV_NAMES, KNOWN_KEYS, resolveConfig, resolveMemoryConfig } from "../src/config.mjs";
import { appendEvent } from "../src/runtime/memory/capture.mjs";
import { openMemory } from "../src/runtime/memory/db.mjs";
import { resolveRepoIdentity } from "../src/runtime/memory/identity.mjs";
import { confirmItem, proposeItem } from "../src/runtime/memory/items.mjs";
import { archiveSession, localOwner, openSession } from "../src/runtime/memory/sessions.mjs";
import { cleanupAll, DAY, git, makeClock, sink, T0, tempDir, track } from "./memory-fixture.mjs";

after(cleanupAll);

const SETTINGS = { historyRetentionDays: 30, summaryRetentionDays: 30 };
const REMOTE = "https://github.com/acme/widgets.git";

async function world({ seed = true } = {}) {
  const userDir = tempDir("aw-memcli-user-");
  const repo = tempDir("aw-memcli-repo-");
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  git(repo, "remote", "add", "origin", REMOTE);
  const env = { ASTERWEAVE_CONFIG_DIR: userDir };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const now = makeClock(T0);
  const w = { userDir, repo, env, now, ids: {} };
  w.cli = async (argv, extraEnv = {}) => {
    const out = sink();
    const err = sink();
    const code = await runCli(["memory", ...argv], { stdout: out, stderr: err, stdin: { isTTY: false }, env: { ...env, ...extraEnv }, cwd: repo, now });
    const text = out.text();
    return { code, out: text, err: err.text(), json: () => JSON.parse(text) };
  };
  if (seed) {
    const mem = track(openMemory({ userDir, now }));
    const { key } = await resolveRepo({ cwd: repo, env });
    const identity = resolveRepoIdentity(mem, { cloneKey: key, kind: "git-common-dir", remote: REMOTE });
    const owner = localOwner(mem);
    Object.assign(w, { mem, identity, owner, repoId: identity.repoId });
    const s = openSession(mem, { id: "ms_cli", owner, identity, title: "Cache design", taskId: "T-7" }, SETTINGS).session;
    appendEvent(mem, s.id, { id: "ev1", type: "message", role: "user", content: "We should cache lookups for five minutes using a token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, SETTINGS);
    appendEvent(mem, s.id, { id: "ev2", type: "message", role: "assistant", content: "Agreed, a short cache avoids hammering the registry" }, SETTINGS);
    const base = { owner, repoId: w.repoId, scope: "repository" };
    w.ids.decision = proposeItem(mem, { ...base, origin: "assistant_suggestion", kind: "decision", content: "Cache registry lookups for five minutes", sourceEventIds: ["ev1"] }, SETTINGS).item.id;
    w.ids.proposed = proposeItem(mem, { ...base, origin: "assistant_suggestion", kind: "decision", content: "Never confirmed secret plan" }, SETTINGS).item.id;
    w.ids.pref = proposeItem(mem, { ...base, origin: "user_decision", kind: "preference", content: "Prefer tabs for indentation" }, SETTINGS).item.id;
    mem.close();
  }
  return w;
}

// --- configuration -----------------------------------------------------------------------------------------

test("memory.* keys: defaults, types, bounds, env names, and user-only precedence", () => {
  const defaults = { enabled: true, defaultScope: "repository", historyRetentionDays: 365, summaryRetentionDays: 365, idleRefreshMinutes: 15, coldResumeMinutes: 60, contextTokenBudget: 4000, retrievalLimit: 8, summaryMinNewEvents: 20, summaryDebounceMinutes: 10, semanticSearchEnabled: false, claudeImportEnabled: false, toolResultExcerptChars: 2000 };
  for (const [name, value] of Object.entries(defaults)) assert.equal(KNOWN_KEYS[`memory.${name}`].default, value, name);
  const keys = Object.keys(KNOWN_KEYS).filter((key) => key.startsWith("memory."));
  assert.equal(keys.length, 13);
  assert.ok(keys.every((key) => KNOWN_KEYS[key].repo !== true && KNOWN_KEYS[key].userSettable !== false), "a repository cannot set any memory key");
  assert.ok(!ENV_NAMES["memory.semanticSearchEnabled"] && !ENV_NAMES["memory.claudeImportEnabled"] && !ENV_NAMES["memory.toolResultExcerptChars"], "the service switches and the tool-evidence size have no environment variable");
  assert.equal(ENV_NAMES["memory.historyRetentionDays"], "ASTERWEAVE_MEMORY_HISTORY_RETENTION_DAYS");
  assert.equal(ENV_NAMES["memory.summaryMinNewEvents"], "ASTERWEAVE_MEMORY_SUMMARY_MIN_NEW_EVENTS");
  assert.equal(ENV_NAMES["memory.summaryDebounceMinutes"], "ASTERWEAVE_MEMORY_SUMMARY_DEBOUNCE_MINUTES");
  for (const [key, bad] of [["memory.historyRetentionDays", 0], ["memory.historyRetentionDays", 3651], ["memory.historyRetentionDays", 1.5], ["memory.historyRetentionDays", "30"], ["memory.enabled", "yes"], ["memory.defaultScope", "team"], ["memory.retrievalLimit", 51], ["memory.contextTokenBudget", 10], ["memory.summaryMinNewEvents", 0], ["memory.summaryMinNewEvents", 10001], ["memory.summaryDebounceMinutes", -1], ["memory.summaryDebounceMinutes", 1441], ["memory.semanticSearchEnabled", 1], ["memory.toolResultExcerptChars", -1], ["memory.toolResultExcerptChars", 16001], ["memory.toolResultExcerptChars", 2.5]]) {
    assert.throws(() => coerceValue(key, bad, { origin: "test" }), ConfigError, `${key}=${bad}`);
  }
  assert.equal(coerceValue("memory.historyRetentionDays", "90", { fromString: true }), 90);
  assert.equal(coerceValue("memory.toolResultExcerptChars", 0, { origin: "test" }), 0, "0 = marker only");
});

test("conflicts: coldResumeMinutes must be at least idleRefreshMinutes, reported with both origins (exit 5)", () => {
  const userDir = tempDir("aw-memcfg-");
  writeFileSync(join(userDir, "config.json"), JSON.stringify({ memory: { idleRefreshMinutes: 90, coldResumeMinutes: 30 } }));
  for (const resolve of [resolveConfig, resolveMemoryConfig]) {
    assert.throws(() => resolve({ env: { ASTERWEAVE_CONFIG_DIR: userDir } }), (error) => error instanceof ConfigError && error.exitCode === 5 && error.key === "memory.coldResumeMinutes" && /idleRefreshMinutes \(90, user:/.test(error.message));
  }
  assert.doesNotThrow(() => resolveMemoryConfig({ env: { ASTERWEAVE_CONFIG_DIR: userDir, ASTERWEAVE_MEMORY_COLD_RESUME_MINUTES: "120" } }));
  writeFileSync(join(userDir, "config.json"), JSON.stringify({ memory: { historyRetentionDays: 400 }, model: { default: "bad id!" } }));
  assert.equal(resolveMemoryConfig({ env: { ASTERWEAVE_CONFIG_DIR: userDir } }).entries["memory.historyRetentionDays"].value, 400, "an unrelated bad key does not break memory");
});

test("a repository adapter cannot carry memory settings", () => {
  const userDir = tempDir("aw-memcfg-user-");
  const repo = tempDir("aw-memcfg-repo-");
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify({ version: 1, memory: { historyRetentionDays: 3650, claudeImportEnabled: true } }));
  assert.throws(() => resolveConfig({ env: { ASTERWEAVE_CONFIG_DIR: userDir }, repoPath: repo }), (error) => error instanceof ConfigError && /unknown top-level property/.test(error.message));
});

// --- commands ------------------------------------------------------------------------------------------------

test("registration: help lists memory, `help memory` documents every subcommand, bad usage is exit 2", async () => {
  const w = await world({ seed: false });
  const help = sink();
  assert.equal(await runCli(["help", "memory"], { stdout: help, stderr: sink(), env: w.env }), 0);
  for (const sub of ["status", "search", "show", "confirm", "correct", "supersede", "forget", "export", "archive", "retention", "capture", "maintain", "repo"]) assert.match(help.text(), new RegExp(`\\n  ${sub} `), sub);
  assert.match(help.text(), /unencrypted/i);
  const all = sink();
  await runCli(["help"], { stdout: all, stderr: sink(), env: w.env });
  assert.match(all.text(), /\n  memory /);
  assert.equal((await w.cli([])).code, 2);
  assert.equal((await w.cli(["frobnicate"])).code, 2);
  assert.equal((await w.cli(["status", "--bogus"])).code, 2);
  assert.equal((await w.cli(["search"], {})).code, 0);
  assert.equal((await w.cli(["search", "x", "--since", "whenever"])).code, 2);
  assert.equal((await w.cli(["show"])).code, 2);
  assert.equal((await w.cli(["correct", "mi_x"])).code, 2, "correct needs --text");
});

test("status: fresh machine reports nothing stored and creates nothing; seeded store reports counts, retention and the unencrypted file", async () => {
  const fresh = await world({ seed: false });
  const empty = await fresh.cli(["status", "--json"]);
  const body = empty.json().memory;
  assert.deepEqual([empty.code, body.storage.exists, body.storage.encrypted, body.settings.enabled, body.settings.historyRetentionDays], [0, false, false, true, 365]);
  assert.equal(existsSync(join(fresh.userDir, "memory")), false, "status never creates the store");
  const w = await world();
  const seeded = (await w.cli(["status", "--json"])).json().memory;
  assert.deepEqual(seeded.counts, { sessions: 1, events: 2, items: 3, checkpoints: 0 });
  assert.equal(seeded.repo.remote, "github.com/acme/widgets");
  assert.equal(seeded.storage.schemaVersion, 4); // migration 4: clone anchors
  const text = (await w.cli(["status"])).out;
  assert.match(text, /Encryption none/);
  assert.match(text, /injected into the model requests of `asterweave run`/);
  assert.match(text, /Import     Claude Code disabled/);
  const traced = await w.cli(["trace", "run-none", "--json"]);
  assert.deepEqual([traced.code, traced.json().traces.length, traced.json().totals.requests], [0, 0, 0]);
  assert.equal((await w.cli(["trace"])).code, 2, "trace needs a run or --session");
});

test("search: strong, weak and absent evidence, filters, items, text and JSON output", async () => {
  const w = await world();
  const strong = (await w.cli(["search", "cache", "five", "minutes", "--json"])).json();
  assert.deepEqual([strong.evidence, strong.events.map((e) => e.id)], ["strong", ["ev1"]]);
  assert.equal(strong.events[0].sessionId, "ms_cli");
  assert.equal(strong.events[0].eventTime, T0);
  assert.match(strong.events[0].eventTimeLocal, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok(!JSON.stringify(strong).includes("abcdefghijklmnopqrstuvwxyz0123456789"), "redacted before it was stored");
  assert.ok(strong.items.length >= 1);
  assert.equal((await w.cli(["search", "cache", "kubernetes", "--json"])).json().evidence, "weak");
  const none = await w.cli(["search", "kubernetes", "--json"]);
  assert.deepEqual([none.code, none.json().evidence], [0, "none"]);
  assert.deepEqual((await w.cli(["search", "cache", "--only", "events", "--json"])).json().items, []);
  assert.equal((await w.cli(["search", "cache", "--task", "T-7", "--session", "ms_cli", "--only", "events", "--json"])).json().events.length, 2);
  assert.equal((await w.cli(["search", "cache", "--since", "2026-11-12T00:00:00Z", "--json"])).json().evidence, "none");
  assert.equal((await w.cli(["search", "cache", "--until", "2026-11-10T00:00:00Z", "--only", "events", "--json"])).json().evidence, "none");
  assert.equal((await w.cli(["search", "cache", "--since", "2026-11-11T00:00:00Z", "--until", "2026-11-12T00:00:00Z", "--only", "events", "--json"])).json().events.length, 2);
  const text = await w.cli(["search", "registry"]);
  assert.match(text.out, /Evidence: strong/);
  assert.match(text.out, /ev2/);
  assert.equal((await w.cli(["search", "x", "--limit", "0"])).code, 2);
});

test("show: an item with its sources, a session with its events, an event", async () => {
  const w = await world();
  const item = (await w.cli(["show", w.ids.decision, "--json"])).json();
  assert.deepEqual([item.type, item.item.status, item.sources[0].available, item.sources[0].id], ["item", "proposed", true, "ev1"]);
  const session = (await w.cli(["show", "ms_cli", "--json"])).json();
  assert.deepEqual([session.type, session.events.length, session.session.title], ["session", 2, "Cache design"]);
  const event = (await w.cli(["show", "ev2", "--json"])).json();
  assert.deepEqual([event.type, event.event.seq, event.sessionId], ["event", 2, "ms_cli"]);
  assert.match((await w.cli(["show", "ev2"])).out, /short cache/);
  const missing = await w.cli(["show", "nothing-like-it", "--json"]);
  assert.deepEqual([missing.code, missing.json().ok, missing.json().error.code], [1, false, "MEMORY_NOT_FOUND"]);
});

test("confirm, correct and supersede keep history; confirmation is the explicit command", async () => {
  const w = await world();
  const confirmed = await w.cli(["confirm", w.ids.decision, "--json"]);
  assert.deepEqual([confirmed.code, confirmed.json().item.status, confirmed.json().item.expiresAt], [0, "confirmed", null]);
  assert.match((await w.cli(["confirm", w.ids.decision])).out, /already confirmed/);
  const corrected = (await w.cli(["correct", w.ids.decision, "--text", "Cache registry lookups for ten minutes", "--json"])).json();
  assert.deepEqual([corrected.item.status, corrected.item.supersedes, corrected.previous.status], ["confirmed", w.ids.decision, "superseded"]);
  const replaced = (await w.cli(["supersede", w.ids.proposed, "--text", "Never mind", "--kind", "constraint", "--json"])).json();
  assert.deepEqual([replaced.item.status, replaced.item.kind, replaced.previous.replacedBy], ["proposed", "constraint", replaced.item.id]);
  assert.equal((await w.cli(["supersede", w.ids.proposed, "--text", "again"])).code, 1, "a superseded item cannot be superseded again");
  assert.equal((await w.cli(["supersede", w.ids.pref, "--text", "x", "--kind", "gossip"])).code, 2);
  const unknown = await w.cli(["confirm", "mi_doesnotexist", "--json"]);
  assert.deepEqual([unknown.code, unknown.json().error.code], [1, "ITEM_NOT_FOUND"]);
});

test("export writes only confirmed repository decisions; never transcripts; --out never overwrites without --force", async () => {
  const w = await world();
  await w.cli(["confirm", w.ids.decision]);
  await w.cli(["confirm", w.ids.pref]);
  const stdout = await w.cli(["export"]);
  assert.match(stdout.out, /Cache registry lookups for five minutes/);
  for (const absent of ["Never confirmed secret plan", "Prefer tabs", "hammering the registry", "ev1"]) assert.ok(!stdout.out.includes(absent), absent);
  const asJson = (await w.cli(["export", "--json"])).json();
  assert.deepEqual([asJson.count, asJson.decisions[0].sourceCount], [1, 1]);
  const target = join(w.repo, "DECISIONS.md");
  assert.equal((await w.cli(["export", "--out", "DECISIONS.md"])).code, 0);
  assert.match(readFileSync(target, "utf8"), /# Project decisions/);
  const again = await w.cli(["export", "--out", "DECISIONS.md", "--json"]);
  assert.deepEqual([again.code, again.json().error.code], [1, "EXPORT_EXISTS"]);
  assert.equal((await w.cli(["export", "--out", "DECISIONS.md", "--force"])).code, 0);
  assert.equal((await w.cli(["export", "--force"])).code, 2);
});

test("forget previews first, deletes only with --yes, and the data does not come back", async () => {
  const w = await world();
  const preview = await w.cli(["forget", "ev1"]);
  assert.equal(preview.code, 2, "a deletion without --yes on a non-terminal is a usage error");
  assert.match(preview.out, /would delete 1 event\(s\), 1 item\(s\)/);
  const json = await w.cli(["forget", "ev1", "--json"]);
  assert.deepEqual([json.code, json.json().ok, json.json().plan.events], [2, false, 1]);
  assert.equal((await w.cli(["search", "lookups", "--only", "events", "--json"])).json().events.length, 1, "nothing was deleted");
  const done = await w.cli(["forget", "ev1", "--yes", "--json"]);
  assert.deepEqual([done.code, done.json().applied, done.json().events, done.json().items], [0, true, 1, 1]);
  assert.equal((await w.cli(["search", "lookups", "--only", "events", "--json"])).json().evidence, "none");
  assert.equal((await w.cli(["show", w.ids.decision])).code, 1, "the item drawn from it went with it");
  const mem = track(openMemory({ userDir: w.userDir, now: w.now }));
  assert.equal(appendEvent(mem, "ms_cli", { id: "ev1", type: "message", content: "again" }, SETTINGS).status, "forgotten");
  assert.equal((await w.cli(["forget", "ev1", "--yes"])).code, 1, "already gone: not found");
  assert.equal((await w.cli(["forget"])).code, 2);
  assert.equal((await w.cli(["forget", "ev2", "--query", "x"])).code, 2);
  const bySearch = await w.cli(["forget", "--query", "registry", "--yes", "--json"]);
  assert.deepEqual([bySearch.code, bySearch.json().events], [0, 1]);
  const session = await w.cli(["forget", "ms_cli", "--yes", "--json"]);
  assert.deepEqual([session.code, session.json().sessions], [0, 1]);
});

test("archive and unarchive: the session stays searchable", async () => {
  const w = await world();
  const archived = (await w.cli(["archive", "ms_cli", "--json"])).json();
  assert.deepEqual([archived.changed, archived.session.state], [true, "archived"]);
  assert.equal((await w.cli(["archive", "ms_cli", "--json"])).json().changed, false);
  assert.equal((await w.cli(["search", "registry", "--json"])).json().events[0].archived, true);
  assert.equal((await w.cli(["unarchive", "ms_cli", "--json"])).json().session.state, "active");
  assert.equal((await w.cli(["archive", "ms_nope"])).code, 1);
  assert.equal((await w.cli(["archive"])).code, 2);
});

test("retention: show, preview ('N events would expire'), apply with --yes and persist to user config without dropping other keys", async () => {
  const w = await world();
  writeFileSync(join(w.userDir, "config.json"), JSON.stringify({ ui: { color: "never" }, memory: { retrievalLimit: 5 } }));
  const mem = track(openMemory({ userDir: w.userDir, now: w.now }));
  appendEvent(mem, "ms_cli", { id: "old", type: "message", content: "an old remark", eventTime: new Date(Date.parse(T0) - 20 * DAY).toISOString() }, SETTINGS);
  mem.close();
  const shown = (await w.cli(["retention", "--json"])).json();
  assert.deepEqual([shown.historyRetentionDays, shown.origin.startsWith("default")], [365, true]);
  const preview = await w.cli(["retention", "--set", "7"]);
  assert.equal(preview.code, 2);
  assert.match(preview.out, /1 event\(s\) would expire now \(of 3 readable\)/);
  assert.equal(JSON.parse(readFileSync(join(w.userDir, "config.json"), "utf8")).memory.historyRetentionDays, undefined, "a preview writes nothing");
  assert.equal((await w.cli(["retention", "--set", "0"])).code, 5);
  assert.equal((await w.cli(["retention", "--set", "abc"])).code, 5);
  const applied = await w.cli(["retention", "--set", "7", "--yes", "--json"]);
  assert.deepEqual([applied.code, applied.json().applied, applied.json().result.events.wouldExpire], [0, true, 1]);
  const config = JSON.parse(readFileSync(join(w.userDir, "config.json"), "utf8"));
  assert.deepEqual(config, { ui: { color: "never" }, memory: { retrievalLimit: 5, historyRetentionDays: 7 } });
  assert.equal((await w.cli(["search", "remark", "--json"])).json().evidence, "none");
  assert.equal((await w.cli(["retention", "--json"])).json().historyRetentionDays, 7);
  const envd = await w.cli(["retention", "--set", "9", "--yes", "--json"], { ASTERWEAVE_MEMORY_HISTORY_RETENTION_DAYS: "30" });
  assert.match(envd.json().warning, /ASTERWEAVE_MEMORY_HISTORY_RETENTION_DAYS is set and overrides/);
});

test("capture off/on persists memory.enabled and says that stored data is kept", async () => {
  const w = await world();
  const off = await w.cli(["capture", "off", "--json"]);
  assert.deepEqual([off.json().enabled, off.json().changed], [false, true]);
  assert.equal(JSON.parse(readFileSync(join(w.userDir, "config.json"), "utf8")).memory.enabled, false);
  assert.match((await w.cli(["capture"])).out, /Capture is off.*Stored data is kept/s);
  assert.equal((await w.cli(["status", "--json"])).json().memory.counts.events, 2, "existing data is untouched");
  assert.equal((await w.cli(["capture", "on", "--json"])).json().enabled, true);
  const overridden = await w.cli(["capture", "off", "--json"], { ASTERWEAVE_MEMORY_ENABLED: "true" });
  assert.match(overridden.json().warning, /overrides memory.enabled/);
  assert.equal((await w.cli(["capture", "maybe"])).code, 2);
});

test("maintain removes expired data in batches and is safe to repeat", async () => {
  const w = await world();
  const idle = await w.cli(["maintain", "--json"]);
  assert.deepEqual([idle.code, idle.json().complete, idle.json().batches], [0, true, 0]);
  w.now.advance(31 * DAY);
  assert.equal((await w.cli(["status", "--json"])).json().memory.pendingCleanup.events, 2);
  assert.equal((await w.cli(["search", "registry", "--json"])).json().evidence, "none", "hidden before it is deleted");
  const partial = (await w.cli(["maintain", "--batch-size", "1", "--max-batches", "1", "--json"])).json();
  assert.deepEqual([partial.removed.events, partial.complete], [1, false]);
  const rest = (await w.cli(["maintain", "--reindex", "--json"])).json();
  assert.deepEqual([rest.complete, rest.reindexed, rest.removed.events], [true, true, 1]);
  assert.equal((await w.cli(["maintain", "--batch-size", "0"])).code, 2);
  assert.equal((await (await world({ seed: false })).cli(["maintain", "--json"])).json().batches, 0, "no store: nothing to do");
});

test("repo: shows the identity; a changed remote needs an explicit resolve", async () => {
  const w = await world();
  const shown = (await w.cli(["repo", "--json"])).json();
  assert.deepEqual([shown.repo.id, shown.repo.status, shown.ambiguities], [w.repoId, "ok", []]);
  git(w.repo, "remote", "set-url", "origin", "https://github.com/acme/widgets-renamed.git");
  const changed = (await w.cli(["repo", "--json"])).json();
  assert.equal(changed.repo.status, "ambiguous");
  assert.equal(changed.repo.id, w.repoId, "still bound to the previous repository");
  assert.equal(changed.ambiguities.length, 1);
  assert.match((await w.cli(["status"])).out, /remote of this clone changed/);
  assert.equal((await w.cli(["repo", "resolve"])).code, 2);
  assert.equal((await w.cli(["repo", "resolve", "maybe"])).code, 2);
  const resolved = (await w.cli(["repo", "resolve", "same", "--json"])).json();
  assert.deepEqual([resolved.resolved.decision, resolved.repo.status, resolved.ambiguities], ["same", "ok", []]);
  assert.equal((await w.cli(["repo", "resolve", "same"])).code, 1, "nothing left to resolve");
});
