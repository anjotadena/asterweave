// Child process for the run-lock tests (not a test file: the runner only picks *.test.mjs).
// Usage: node run-lock-child.mjs <runDir> <goFile>
// Acquires the run lock with the heartbeat running, prints `ready <pid>`, then waits. When <goFile>
// appears it releases the lock and exits 0. It gives up on its own after 30 s (exit 2), so a failed
// parent test never leaves an orphan holding the lock. The parent may also kill it to simulate a crash.

import { existsSync } from "node:fs";
import { acquireRunLock } from "../src/runtime/lock.mjs";

const [dir, goFile] = process.argv.slice(2);
let lock;
try {
  lock = acquireRunLock(dir, { timeoutMs: 1000 });
} catch (error) {
  console.error(error?.code ?? error?.message);
  process.exit(1);
}
lock.startHeartbeat();
console.log(`ready ${process.pid}`);

const started = Date.now();
const poll = setInterval(() => {
  const finished = existsSync(goFile);
  if (finished || Date.now() - started > 30_000) {
    clearInterval(poll);
    lock.release();
    process.exit(finished ? 0 : 2);
  }
}, 20);
