// Run lock: acquire/release, staleness (dead pid / expired heartbeat), takeover races, bounded waiting,
// and a real child process.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireRunLock, defaultPidAlive, inspectRunLock } from "../src/runtime/lock.mjs";
import { cleanupTemp, tempDir, waitFor } from "./repo-fixture.mjs";

after(cleanupTemp);

const childPath = fileURLToPath(new URL("./run-lock-child.mjs", import.meta.url));
const HOST = "test-host";
const isLocked = (error) => error?.code === "RUN_LOCKED" && error.exitCode === 1;

const runDirectory = () => tempDir("aw-runlock-");
const lockPath = (dir) => join(dir, "run.lock");
const readLock = (dir) => JSON.parse(readFileSync(lockPath(dir), "utf8"));
const leftovers = (dir) => readdirSync(dir).filter((name) => name !== "run.lock");

/** Write a lock owned by somebody else, with the given heartbeat age. */
function plantLock(dir, { pid = 424_242, hostname = HOST, token = "someone-else", ageMs = 0 } = {}) {
  writeFileSync(lockPath(dir), JSON.stringify({ pid, hostname, token, acquiredAt: new Date().toISOString() }));
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(lockPath(dir), seconds, seconds);
}

const withFs = (overrides) => ({ ...nodeFs, ...overrides });

test("acquire writes pid/hostname/token/acquiredAt; release removes it once", () => {
  const dir = runDirectory();
  const lock = acquireRunLock(dir, { hostname: HOST });
  const body = readLock(dir);
  assert.deepEqual(Object.keys(body).sort(), ["acquiredAt", "hostname", "pid", "token"]);
  assert.deepEqual([body.pid, body.hostname, body.token], [process.pid, HOST, lock.token]);
  assert.ok(!Number.isNaN(Date.parse(body.acquiredAt)));
  assert.equal(inspectRunLock(dir, { hostname: HOST }).state, "live");
  assert.equal(lock.release(), true);
  assert.equal(existsSync(lockPath(dir)), false);
  assert.equal(lock.release(), false, "a second release is a no-op");
  assert.equal(inspectRunLock(dir).state, "none");
  acquireRunLock(dir).release(); // can be taken again
});

test("a live lock fails immediately with RUN_LOCKED (exit 1) and is left untouched", () => {
  const dir = runDirectory();
  const first = acquireRunLock(dir, { hostname: HOST, pidAlive: () => true });
  const sleeps = [];
  assert.throws(
    () => acquireRunLock(dir, { hostname: HOST, pidAlive: () => true, sleep: (ms) => sleeps.push(ms) }),
    (error) => isLocked(error) && error.owner.pid === process.pid && /locked by pid/.test(error.message) && /remediation|Wait|remove/i.test(error.remediation),
  );
  assert.deepEqual(sleeps, [], "a live lock does not wait out the timeout");
  assert.equal(readLock(dir).token, first.token);
  first.release();
});

test("same host and dead pid: taken over even though the heartbeat is fresh; a live pid is not", () => {
  const dir = runDirectory();
  plantLock(dir, { ageMs: 0 });
  assert.throws(() => acquireRunLock(dir, { hostname: HOST, pidAlive: () => true }), isLocked);
  assert.equal(readLock(dir).token, "someone-else");

  const asked = [];
  const taker = acquireRunLock(dir, { hostname: HOST, pidAlive: (pid) => (asked.push(pid), false) });
  assert.ok(asked.includes(424_242));
  assert.equal(readLock(dir).token, taker.token);
  assert.deepEqual(leftovers(dir), [], "no .stale-* file is left behind");
  taker.release();
});

test("foreign host with a fresh heartbeat is held, and its pid is never probed", () => {
  const dir = runDirectory();
  plantLock(dir, { hostname: "another-host", ageMs: 1000 });
  const probed = [];
  assert.throws(() => acquireRunLock(dir, { hostname: HOST, pidAlive: (pid) => (probed.push(pid), false) }), isLocked);
  assert.deepEqual(probed, []);
  assert.equal(readLock(dir).token, "someone-else");
});

test("a heartbeat older than staleMs is taken over (foreign host); one just inside the limit is not", () => {
  const dir = runDirectory();
  plantLock(dir, { hostname: "another-host", ageMs: 59_000 });
  assert.throws(() => acquireRunLock(dir, { hostname: HOST }), isLocked);
  plantLock(dir, { hostname: "another-host", ageMs: 61_000 });
  const taker = acquireRunLock(dir, { hostname: HOST });
  assert.equal(readLock(dir).token, taker.token);
  assert.deepEqual(leftovers(dir), []);
  assert.equal(inspectRunLock(dir, { hostname: HOST }).state, "live");
  taker.release();

  plantLock(dir, { hostname: "another-host", ageMs: 5_000 });
  assert.equal(inspectRunLock(dir, { hostname: HOST, staleMs: 1_000 }).reason, "heartbeat-expired");
  const tight = acquireRunLock(dir, { hostname: HOST, staleMs: 1_000 });
  tight.release();
});

test("an unparseable lock is judged by its heartbeat alone", () => {
  const dir = runDirectory();
  writeFileSync(lockPath(dir), "{ half written");
  assert.throws(() => acquireRunLock(dir, { hostname: HOST }), isLocked);
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(lockPath(dir), old, old);
  acquireRunLock(dir, { hostname: HOST }).release();
});

test("heartbeat refreshes the mtime; a lock somebody else took over is reported lost", () => {
  const dir = runDirectory();
  const clock = Date.now();
  const lock = acquireRunLock(dir, { hostname: HOST, now: () => clock });
  const old = (clock - 50_000) / 1000;
  utimesSync(lockPath(dir), old, old);
  assert.ok(clock - statSync(lockPath(dir)).mtimeMs > 40_000);
  assert.equal(lock.heartbeat(), true);
  assert.ok(Math.abs(statSync(lockPath(dir)).mtimeMs - clock) < 2000, "mtime moved to now");

  writeFileSync(lockPath(dir), JSON.stringify({ pid: 1, hostname: "x", token: "thief" }));
  assert.equal(lock.heartbeat(), false);
  assert.equal(lock.lost, true);
  assert.equal(lock.release(), false, "release of a lock that is not ours is a no-op");
  assert.equal(readLock(dir).token, "thief");
});

test("startHeartbeat uses an unref'd timer that beats the lock and is cleared on release", () => {
  const dir = runDirectory();
  const timers = [];
  const cleared = [];
  const clock = Date.now();
  const lock = acquireRunLock(dir, {
    hostname: HOST,
    now: () => clock,
    heartbeatMs: 1234,
    setInterval: (callback, ms) => {
      const handle = { callback, ms, unrefd: false, unref() { this.unrefd = true; return this; } };
      timers.push(handle);
      return handle;
    },
    clearInterval: (handle) => cleared.push(handle),
  });
  lock.startHeartbeat();
  lock.startHeartbeat();
  assert.equal(timers.length, 1, "started once");
  assert.equal(timers[0].ms, 1234);
  assert.equal(timers[0].unrefd, true, "an unref'd timer never keeps the process alive");
  const old = (clock - 50_000) / 1000;
  utimesSync(lockPath(dir), old, old);
  timers[0].callback();
  assert.ok(Math.abs(statSync(lockPath(dir)).mtimeMs - clock) < 2000);
  lock.release();
  assert.deepEqual(cleared, [timers[0]]);
  lock.startHeartbeat();
  assert.equal(timers.length, 1, "no new timer after release");

  // The default timer is real and unref'd: a started-but-never-released lock must not hang the process.
  const hang = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { acquireRunLock } from ${JSON.stringify(new URL("../src/runtime/lock.mjs", import.meta.url).href)}; acquireRunLock(process.argv[1]).startHeartbeat();`, dir],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(hang.error, undefined, "child exited by itself");
  assert.equal(hang.status, 0, hang.stderr);
});

test("no spin: a lock that can be neither created nor read ends in RUN_LOCKED within the timeout", () => {
  const dir = runDirectory();
  const contested = (extra) =>
    withFs({
      writeFileSync(file, ...rest) {
        if (String(file) === lockPath(dir)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        return nodeFs.writeFileSync(file, ...rest);
      },
      lstatSync(file, ...rest) {
        if (String(file) === lockPath(dir)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return nodeFs.lstatSync(file, ...rest);
      },
      ...extra,
    });
  const attempt = (fs) => {
    const sleeps = [];
    const started = Date.now();
    assert.throws(() => acquireRunLock(dir, { fs, timeoutMs: 500, sleep: (ms) => sleeps.push(ms) }), isLocked);
    assert.ok(Date.now() - started < 3000, "returns promptly (the injected sleep does not wait)");
    assert.equal(sleeps.reduce((a, b) => a + b, 0), 500, "every attempt sleeps and counts toward the timeout");
    assert.ok(sleeps.length >= 3 && sleeps.length <= 20 && sleeps.every((ms) => ms > 0), JSON.stringify(sleeps));
  };
  // create: always EEXIST; stat: always ENOENT (the lock "vanishes" every time, so there is never anything to judge)
  attempt(contested());
  // Same, but the read also reports ENOENT after a successful stat.
  attempt(
    contested({
      lstatSync: (file, ...rest) => (String(file) === lockPath(dir) ? { isFile: () => true, mtimeMs: Date.now() } : nodeFs.lstatSync(file, ...rest)),
      readFileSync(file, ...rest) {
        if (String(file) === lockPath(dir)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return nodeFs.readFileSync(file, ...rest);
      },
    }),
  );
});

test("an unreadable lock (stat fine, read always fails) is treated as held until the timeout", () => {
  const dir = runDirectory();
  plantLock(dir, { hostname: "another-host", ageMs: 0 });
  const sleeps = [];
  const fs = withFs({
    readFileSync(file, ...rest) {
      if (String(file) === lockPath(dir)) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return nodeFs.readFileSync(file, ...rest);
    },
  });
  assert.throws(() => acquireRunLock(dir, { fs, hostname: HOST, timeoutMs: 300, sleep: (ms) => sleeps.push(ms) }), isLocked);
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 300);
  assert.equal(readLock(dir).token, "someone-else", "an unjudgeable lock is never removed");
});

test("a lock path that is not a regular file is refused, not removed", () => {
  const dir = runDirectory();
  mkdirSync(lockPath(dir));
  assert.throws(() => acquireRunLock(dir, { hostname: HOST }), (error) => error.code === "RUN_LOCK_INVALID" && error.exitCode === 1);
  assert.equal(statSync(lockPath(dir)).isDirectory(), true);
});

test("a missing run directory is RUN_LOCK_FAILED, not a wait", () => {
  const dir = join(runDirectory(), "absent");
  const sleeps = [];
  assert.throws(() => acquireRunLock(dir, { sleep: (ms) => sleeps.push(ms) }), (error) => error.code === "RUN_LOCK_FAILED");
  assert.deepEqual(sleeps, []);
});

test("EPERM on create is contention only on win32", () => {
  const dir = runDirectory();
  const denied = withFs({
    writeFileSync(file, ...rest) {
      if (String(file) === lockPath(dir)) throw Object.assign(new Error("denied"), { code: "EPERM" });
      return nodeFs.writeFileSync(file, ...rest);
    },
  });
  const posix = [];
  assert.throws(() => acquireRunLock(dir, { fs: denied, platform: "linux", sleep: (ms) => posix.push(ms) }), (error) => error.code === "RUN_LOCK_FAILED");
  assert.deepEqual(posix, []);
  const win = [];
  assert.throws(() => acquireRunLock(dir, { fs: denied, platform: "win32", timeoutMs: 100, sleep: (ms) => win.push(ms) }), isLocked);
  assert.equal(win.reduce((a, b) => a + b, 0), 100);
});

test("takeover race: a second taker that slips in between check and rename keeps its lock", () => {
  const dir = runDirectory();
  plantLock(dir, { hostname: "another-host", ageMs: 120_000 });
  const common = { hostname: HOST, pidAlive: () => true };
  let rival = null;
  let hooked = 0;
  const interleaved = withFs({
    renameSync(from, to) {
      if (String(from) === lockPath(dir) && hooked === 0) {
        hooked += 1;
        rival = acquireRunLock(dir, common); // completes its whole takeover before our rename runs
      }
      return nodeFs.renameSync(from, to);
    },
  });
  assert.throws(() => acquireRunLock(dir, { ...common, fs: interleaved, sleep: () => {} }), isLocked);
  assert.equal(hooked, 1);
  assert.ok(rival, "the rival acquired");
  assert.equal(readLock(dir).token, rival.token, "exactly one holder: the rival");
  assert.deepEqual(leftovers(dir), []);
  assert.equal(rival.heartbeat(), true, "the rival never lost the lock");
  assert.equal(rival.release(), true);
});

test("takeover race: an owner heartbeat between the stale check and the rename keeps the lock", () => {
  const dir = runDirectory();
  plantLock(dir, { hostname: "another-host", ageMs: 120_000 });
  const original = readFileSync(lockPath(dir), "utf8");
  let hooked = 0;
  const interleaved = withFs({
    renameSync(from, to) {
      if (String(from) === lockPath(dir) && hooked === 0) {
        hooked += 1;
        const now = Date.now() / 1000;
        utimesSync(lockPath(dir), now, now); // the owner's heartbeat
      }
      return nodeFs.renameSync(from, to);
    },
  });
  assert.throws(() => acquireRunLock(dir, { hostname: HOST, fs: interleaved, sleep: () => {} }), isLocked);
  assert.equal(hooked, 1);
  assert.equal(readFileSync(lockPath(dir), "utf8"), original, "the owner's lock was restored");
  assert.ok(Date.now() - statSync(lockPath(dir)).mtimeMs < 10_000, "with its fresh heartbeat");
  assert.deepEqual(leftovers(dir), []);
});

test("the owner dying between the check and the rename still allows the takeover (full predicate on the moved file)", () => {
  const dir = runDirectory();
  plantLock(dir, { ageMs: 0 }); // fresh heartbeat, same host: only the dead pid makes it stale
  const taker = acquireRunLock(dir, { hostname: HOST, pidAlive: () => false });
  assert.equal(readLock(dir).token, taker.token);
  assert.deepEqual(leftovers(dir), []);
  taker.release();
});

test("defaultPidAlive: ESRCH is dead, EPERM is alive, a live pid is alive", () => {
  assert.equal(defaultPidAlive(process.pid), true);
  const finished = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(defaultPidAlive(finished.pid), false);
  const original = process.kill;
  try {
    process.kill = () => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    };
    assert.equal(defaultPidAlive(1), true);
    process.kill = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    assert.equal(defaultPidAlive(1), false);
  } finally {
    process.kill = original;
  }
});

function startChild(dir, goFile) {
  const child = spawn(process.execPath, [childPath, dir, goFile], { stdio: ["ignore", "pipe", "pipe"] });
  const state = { out: "", err: "", exited: false, code: null };
  child.stdout.on("data", (data) => { state.out += data; });
  child.stderr.on("data", (data) => { state.err += data; });
  state.done = new Promise((resolve) => child.on("exit", (code) => { state.exited = true; state.code = code; resolve(state); }));
  state.child = child;
  children.push(child);
  return state;
}
const children = [];
after(() => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
});

test("real child: a second acquire is RUN_LOCKED; after the child is killed the dead pid allows a takeover", async () => {
  const dir = runDirectory();
  const goFile = join(dir, "go");
  const state = startChild(dir, goFile);
  await waitFor(() => /ready \d+/.test(state.out) || state.exited, { timeoutMs: 15_000, label: "child to hold the lock" });
  assert.match(state.out, /ready \d+/, state.err);
  const childPid = state.child.pid;

  assert.throws(() => acquireRunLock(dir), (error) => isLocked(error) && error.owner.pid === childPid);
  assert.equal(readLock(dir).pid, childPid);
  assert.equal(inspectRunLock(dir).state, "live");

  state.child.kill(); // SIGTERM on POSIX; a hard kill on Windows. Either way no release runs.
  await state.done; // reaped: a zombie would still answer kill(pid, 0)
  assert.ok(Date.now() - statSync(lockPath(dir)).mtimeMs < 30_000, "the heartbeat is fresh, so only the dead pid makes it stale");
  assert.equal(readLock(dir).pid, childPid);

  let taker = null;
  await waitFor(
    () => {
      try {
        taker = acquireRunLock(dir);
        return true;
      } catch (error) {
        if (!isLocked(error)) throw error;
        return false;
      }
    },
    { timeoutMs: 10_000, label: "takeover after the child died" },
  );
  assert.equal(readLock(dir).pid, process.pid);
  assert.equal(readLock(dir).token, taker.token);
  assert.deepEqual(leftovers(dir).filter((name) => name !== "go"), []);
  taker.release();
});

test("real child: released on the go signal, after which the lock is simply free", async () => {
  const dir = runDirectory();
  const goFile = join(dir, "go");
  const state = startChild(dir, goFile);
  await waitFor(() => /ready \d+/.test(state.out) || state.exited, { timeoutMs: 15_000, label: "child to hold the lock" });
  assert.match(state.out, /ready \d+/, state.err);
  assert.throws(() => acquireRunLock(dir), isLocked);
  writeFileSync(goFile, "go");
  await state.done;
  assert.equal(state.code, 0, state.err);
  assert.equal(existsSync(lockPath(dir)), false, "the child released its lock");
  acquireRunLock(dir).release();
});
