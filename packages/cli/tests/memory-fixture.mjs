// Shared helpers for the memory tests (not a test file: the runner only picks *.test.mjs).
// A fake clock, a temp user directory and seeding helpers; nothing touches the real user directory or the network.

import { existsSync, readFileSync } from "node:fs";
import { openMemory } from "../src/runtime/memory/db.mjs";
import { appendEvent } from "../src/runtime/memory/capture.mjs";
import { resolveRepoIdentity } from "../src/runtime/memory/identity.mjs";
import { openSession } from "../src/runtime/memory/sessions.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";

export { git, tempDir } from "./repo-fixture.mjs";

const opened = [];
/** Remember a handle so cleanupAll can close it (Windows cannot delete an open database). */
export const track = (mem) => {
  if (mem) opened.push(mem);
  return mem;
};
/** Close every tracked handle, then remove the temp directories. */
export function cleanupAll() {
  for (const mem of opened.splice(0)) mem.close();
  cleanupTemp();
}

export const DAY = 86_400_000;
export const T0 = "2026-11-11T09:30:00.000Z";

/** A settable clock: `clock()` is the `now` seam (ISO string), `.set(iso)`, `.advance(ms)`. */
export function makeClock(start = T0) {
  let t = Date.parse(start);
  const now = () => new Date(t).toISOString();
  now.set = (iso) => {
    t = Date.parse(iso);
  };
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

export const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};

/** A temp user directory, a clock, an open store and one repository identity. */
export function world({ remote = "https://github.com/acme/widgets.git", cloneKey = "/clone/widgets", start = T0 } = {}) {
  const userDir = tempDir("aw-mem-");
  const now = makeClock(start);
  const open = () => track(openMemory({ userDir, now }));
  const mem = open();
  const identity = resolveRepoIdentity(mem, { cloneKey, remote });
  const owner = "u_alice";
  const settings = { historyRetentionDays: 10, summaryRetentionDays: 10 };
  const session = (extra = {}) => {
    const result = openSession(mem, { owner, identity, title: "Session", ...extra }, settings);
    if (!result.ok || !result.saved) throw new Error(`session not opened: ${JSON.stringify(result)}`);
    return result.session;
  };
  let counter = 0;
  const event = (sessionId, content, extra = {}) => {
    counter += 1;
    const result = appendEvent(mem, sessionId, { id: extra.id ?? `evt-${counter}`, type: "message", role: "user", content, ...extra }, settings);
    if (!result.ok || !result.saved) throw new Error(`event not saved: ${JSON.stringify(result)}`);
    return result;
  };
  return { userDir, now, mem, open, identity, repoId: identity.repoId, owner, settings, session, event };
}

/** All bytes of the database and its write-ahead log, as latin1 text, for "is this text still on disk" checks. */
export function rawBytes(mem) {
  return ["", "-wal", "-shm"].map((suffix) => (existsSync(mem.path + suffix) ? readFileSync(mem.path + suffix).toString("latin1") : "")).join("\n");
}
