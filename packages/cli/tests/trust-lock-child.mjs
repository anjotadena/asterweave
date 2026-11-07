// Child process for the concurrent-grant test (not a test file: the runner only picks *.test.mjs).
// Usage: node trust-lock-child.mjs <trust.json> <repo> <delayMs> <goFile>
// Prints `ready`, waits until <goFile> exists (the parent releases every child at once), then grants
// trust for <repo>, sleeping <delayMs> after the trust store is read so that two children overlap
// inside their read-modify-write section (a lost update without the lock). Prints `waited` when the
// store lock made it back off, which proves the overlap really happened.

import * as nodeFs from "node:fs";
import { grantTrust } from "../src/trust.mjs";

const [trustFile, repo, delay, goFile] = process.argv.slice(2);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const fs = {
  ...nodeFs,
  readFileSync(file, ...rest) {
    try {
      return nodeFs.readFileSync(file, ...rest);
    } finally {
      if (String(file) === trustFile) pause(Number(delay));
    }
  },
};
console.log("ready");
for (let waitedMs = 0; !nodeFs.existsSync(goFile); waitedMs += 5) {
  if (waitedMs > 20_000) {
    console.error("never released");
    process.exit(2);
  }
  pause(5);
}
try {
  grantTrust(repo, {
    trustFile,
    fs,
    sleep(ms) {
      console.log("waited");
      pause(ms);
    },
  });
} catch (error) {
  console.error(error?.code ?? error?.message);
  process.exitCode = 1;
}
