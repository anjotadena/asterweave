// `asterweave plugin ...` through the REAL admin runner and mutation envelope (Track A) against the scripted fake claude (admin mode).
// Isolated HOME/USERPROFILE/APPDATA/config dirs; no real claude, no real ~/.claude.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { cleanup, realWorld } from "./plugin-fixture.mjs";
import { readJsonFile } from "./admin-fixture.mjs";

after(cleanup);

const envelopeWorld = realWorld;

test("a non-terminal needs --yes: no claude call, exit 2; nothing is spawned", async () => {
  const w = envelopeWorld();
  const r = await w.run(["install", "p@market", "--scope", "global"]);
  assert.equal(r.code, 2);
  assert.deepEqual(w.calls(), []);
  const json = await w.run(["install", "p@market", "--scope", "global", "--json"]);
  assert.equal(json.code, 2);
  assert.deepEqual(w.calls(), []);
  assert.equal(JSON.parse(json.out).ok, false);
});

test("global install through the real envelope: -s user, one JSON document, repository trust untouched", async () => {
  const w = envelopeWorld();
  w.trust();
  const r = await w.run(["install", "p@market", "--scope", "global", "--config", "mode=fast", "--yes", "--json"]);
  assert.equal(r.code, 0, r.err + r.out);
  const body = JSON.parse(r.out);
  assert.deepEqual([body.ok, body.verified, body.claudeScope], [true, true, "user"]);
  assert.match(body.warnings.join(" "), /run code/);
  assert.deepEqual(w.calls(), [["plugin", "install", "p@market", "-s", "user", "--config", "mode=fast"]]);
  assert.equal(readJsonFile(join(w.home, ".claude", "settings.json")).enabledPlugins["p@market"], true);
  assert.equal(w.trusted(), true);
});

test("repo install: exit 4 and untrusted until re-granted; --trust re-grants only after a prompt, from a trusted repository", async () => {
  const w = envelopeWorld();
  w.trust();
  const r = await w.run(["install", "p@market", "--scope", "repo", "--yes"]);
  assert.equal(r.code, 4, r.err + r.out);
  assert.equal(w.trusted(), false);
  assert.match(r.out, /trust grant/);
  assert.equal(readJsonFile(join(w.repo, ".claude", "settings.json")).enabledPlugins["p@market"], true);
  assert.deepEqual(w.calls()[0].slice(0, 5), ["plugin", "install", "p@market", "-s", "project"]);
  w.trust();
  const t = await w.tty(["disable", "p@market", "--scope", "repo", "--trust"], ["y", "y"]);
  assert.equal(t.code, 0, t.err + t.out);
  assert.equal(w.trusted(), true);
  assert.equal(readJsonFile(join(w.repo, ".claude", "settings.json")).enabledPlugins["p@market"], false);
});

test("an unexpected claude change is UNEXPECTED_CHANGE (exit 1) and never re-trusts", async () => {
  const w = envelopeWorld("edit-settings");
  w.trust();
  const r = await w.run(["install", "p@market", "--scope", "repo", "--yes", "--trust", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).error.code, "UNEXPECTED_CHANGE");
  assert.equal(w.trusted(), false);
  const g = envelopeWorld("edit-settings");
  const global = await g.run(["install", "p@market", "--scope", "global", "--yes", "--json"]);
  assert.equal(global.code, 1);
  assert.equal(JSON.parse(global.out).error.code, "UNEXPECTED_CHANGE");
});

test("agent environment markers refuse the real envelope too (exit 7) before any claude call", async () => {
  const w = envelopeWorld();
  w.env.ASTERWEAVE_SESSION_ID = "s1";
  const r = await w.run(["install", "p@market", "--scope", "global", "--yes"]);
  assert.equal(r.code, 7);
  assert.deepEqual(w.calls(), []);
});

test("--config token=${PLUGIN_TOKEN} (a whole reference) passes the REAL admin runner; a literal secret is refused before any call", async () => {
  const w = envelopeWorld();
  const ok = await w.run(["install", "p@market", "--scope", "global", "--yes", "--config", "token=${PLUGIN_TOKEN}"]);
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(w.calls().at(-1), ["plugin", "install", "p@market", "-s", "user", "--config", "token=${PLUGIN_TOKEN}"]);
  const before = w.calls().length;
  const literal = await w.run(["install", "q@market", "--scope", "global", "--yes", "--config", "token=hunter2hunter2"]);
  assert.equal(literal.code, 2);
  assert.ok(!(literal.out + literal.err).includes("hunter2hunter2"));
  assert.equal(w.calls().length, before);
});
