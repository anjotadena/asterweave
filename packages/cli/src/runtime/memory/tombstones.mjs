// Content-free deletion markers. A tombstone is the hash of an id plus the kind and the time of deletion: nothing from the
// deleted text. Every insert path (capture, session open, item creation, any later import or reindex) asks `isTombstoned`
// first, so data the user forgot cannot come back by replaying its source.

import { createHash } from "node:crypto";

export const tombstoneHash = (kind, id) => createHash("sha256").update(`${kind}:${String(id)}`).digest("hex");

/** @param {import('node:sqlite').DatabaseSync} db */
export function isTombstoned(db, kind, id) {
  return db.prepare("SELECT 1 FROM tombstones WHERE hash = ?").get(tombstoneHash(kind, id)) !== undefined;
}

/** @param {import('node:sqlite').DatabaseSync} db */
export function addTombstone(db, kind, id, at) {
  db.prepare("INSERT OR IGNORE INTO tombstones (hash, kind, deleted_at) VALUES (?, ?, ?)").run(tombstoneHash(kind, id), kind, at);
}
