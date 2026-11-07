// Child process for the session-store concurrency tests (not a test file: the runner only picks *.test.mjs).
// Usage: node session-store-child.mjs <userDir> <repoKey> <fork|archive> <sessionId> <goFile>
// Waits for <goFile> to exist (so several children start together), runs the operation, prints one JSON line.

import { existsSync } from "node:fs";
import { archiveSession, forkSession } from "../src/runtime/sessions.mjs";

const [userDir, repoKey, op, id, goFile] = process.argv.slice(2);
const started = Date.now();
while (!existsSync(goFile)) {
  if (Date.now() - started > 20_000) process.exit(2);
  await new Promise((resolve) => setTimeout(resolve, 5));
}
try {
  const result = op === "fork" ? forkSession(repoKey, id, { userDir }) : archiveSession(repoKey, id, { userDir });
  console.log(JSON.stringify({ ok: true, id: result.session.id, changed: result.changed ?? null }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error?.code ?? String(error?.message) }));
  process.exit(1);
}
