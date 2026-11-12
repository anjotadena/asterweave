// Deterministic decision extraction (no model call). Conservative on purpose: a false positive (a "decision" nobody made) is
// worse than a miss, so only a few explicit phrasings count, questions and negated sentences never do, and every result is a
// PROPOSAL (status `proposed`). Nothing here confirms, disputes or replaces a CONFIRMED item (M1 rule: only the owner's explicit
// act does): extraction never passes `explicit: true`.
//
//   user:      "we decided ...", "let's use X", "switch to X", a line starting "approved:", a line starting "requirement:"
//              -> origin user_decision (kind decision, or requirement)
//   assistant: only a line starting "Decision:" or "Recommendation:" -> origin assistant_suggestion. A suggestion never
//              supersedes or disputes anything.
//
// SAME SUBJECT. A statement's subject is the phrase after "for" ("use pnpm for package management" -> "package management"), or
// the thing it replaces ("switch to pnpm from npm", "instead of npm"). A later USER decision on the same subject:
//   - with an explicit replacement ("switch to", "instead of", "rather than", "no longer", "replace") supersedes a PROPOSED
//     earlier item (history kept: the old one is `superseded` and links forward);
//   - without one, both are marked `disputed` (a conflict for a person to settle);
//   - against a CONFIRMED item, the new one is recorded `disputed` and the confirmed item is left untouched.
// IDEMPOTENT: an event that already sourced an item is never extracted again (item_sources).

import { createHash } from "node:crypto";
import { disputeItem, proposeItem, supersedeItem, toItem } from "./items.mjs";
import { notExpired } from "./db.mjs";

const MAX_STATEMENTS = 5;
const sentenceSplit = (text) => String(text ?? "").split(/(?<=[.!?])\s+|\r?\n/).map((s) => s.trim()).filter(Boolean);
const NEGATION = /\b(?:not|don't|do not|never|shouldn't|won't|no longer consider)\b/i;

const USER_RULES = [
  { re: /^(?:ok(?:ay)?,?\s+)?we(?:'ve| have)? (?:decided|agreed)(?: to| that| on)?\s+(.{3,240})$/i, kind: "decision" },
  { re: /^(?:ok(?:ay)?,?\s+)?let'?s use\s+(.{2,200})$/i, kind: "decision" },
  { re: /^(?:ok(?:ay)?,?\s+)?(?:we(?:'ll| will)?\s+)?switch(?:ing)? to\s+(.{2,200})$/i, kind: "decision", replacing: true },
  { re: /^approved:\s*(.{3,240})$/i, kind: "decision" },
  { re: /^requirement:\s*(.{3,300})$/i, kind: "requirement" },
];
const ASSISTANT_RULES = [{ re: /^(?:decision|recommendation):\s*(.{3,240})$/i, kind: "decision" }];

const norm = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();

/** The subject of a statement (see header), or null. */
export function subjectOf(text) {
  const lower = norm(text);
  const forMatch = /\bfor (?:the |our |all )?([\p{L}\p{N}-]+(?: [\p{L}\p{N}-]+){0,3})/u.exec(lower);
  if (forMatch) return forMatch[1].replace(/ (instead|rather|from)\b.*$/, "").trim() || null;
  return null;
}

/** What a statement explicitly replaces ("instead of X", "rather than X", "from X", "no longer X", "replace X"), or null. */
export function replacedOf(text) {
  const lower = norm(text);
  const m = /\b(?:instead of|rather than|from|no longer use|replace)\s+([\p{L}\p{N}-]+)/u.exec(lower);
  return m ? m[1] : null;
}

/**
 * Statements a message proposes. Pure.
 * @param {string} text @param {'user'|'assistant'} role
 * @returns {Array<{kind: string, content: string, origin: string, subject: string|null, replaces: string|null, explicitReplacement: boolean}>}
 */
export function extractStatements(text, role) {
  const rules = role === "user" ? USER_RULES : role === "assistant" ? ASSISTANT_RULES : [];
  const out = [];
  for (const sentence of sentenceSplit(text)) {
    if (out.length >= MAX_STATEMENTS) break;
    if (sentence.endsWith("?")) continue;
    for (const rule of rules) {
      const m = rule.re.exec(sentence);
      if (!m) continue;
      const body = m[1].replace(/[.!]+$/, "").trim();
      if (body.length < 2 || NEGATION.test(sentence.slice(0, m.index + 20)) || /\?/.test(body)) break;
      const content = role === "user" ? sentence.replace(/[.!]+$/, "") : body;
      const replaces = replacedOf(sentence);
      out.push({ kind: rule.kind, content, origin: role === "user" ? "user_decision" : "assistant_suggestion", subject: subjectOf(sentence), replaces, explicitReplacement: role === "user" && (rule.replacing === true || replaces !== null) });
      break;
    }
  }
  return out;
}

const itemId = (eventId, index) => `mi_x${createHash("sha256").update(`${eventId}#${index}`).digest("hex").slice(0, 20)}`;

function conflicting(mem, { owner, repoId }, statement) {
  const rows = mem.db
    .prepare(`SELECT * FROM memory_items WHERE owner = :owner AND repo_id = :repo AND origin = 'user_decision' AND status IN ('proposed', 'confirmed') AND ${notExpired("expires_at")} ORDER BY recorded_at DESC LIMIT 200`)
    .all({ owner, repo: repoId, now: mem.now() });
  return rows.map(toItem).find((item) => {
    if (statement.subject && subjectOf(item.content) === statement.subject) return true;
    return statement.replaces !== null && new RegExp(`\\b${statement.replaces.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(item.content);
  }) ?? null;
}

/**
 * Extract and store proposals from one captured event. Never throws; returns what it did.
 * @param {import('./db.mjs').Memory} mem
 * @param {{owner: string, repoId: string, sessionId: string, eventId: string, role: string, content: string}} input
 * @returns {{proposed: string[], superseded: string[], disputed: string[], skipped: boolean, failed: object|null}}
 */
export function extractDecisions(mem, input, settings) {
  const done = { proposed: [], superseded: [], disputed: [], skipped: false, failed: null };
  try {
    if (mem.db.prepare("SELECT 1 FROM item_sources WHERE event_id = ?").get(input.eventId)) return { ...done, skipped: true };
    const statements = extractStatements(input.content, input.role);
    statements.forEach((statement, index) => {
      const base = { owner: input.owner, repoId: input.repoId, scope: "repository", kind: statement.kind, content: statement.content, origin: statement.origin, sourceEventIds: [input.eventId] };
      const prior = statement.origin === "user_decision" ? conflicting(mem, input, statement) : null;
      if (prior && prior.status === "proposed" && statement.explicitReplacement) {
        const result = supersedeItem(mem, prior.id, input.owner, { content: statement.content, kind: statement.kind, origin: "user_decision", sourceEventIds: [input.eventId] }, settings);
        if (result.ok) {
          done.superseded.push(prior.id);
          done.proposed.push(result.item.id);
        } else done.failed = result;
        return;
      }
      const result = proposeItem(mem, { ...base, id: itemId(input.eventId, index) }, settings);
      if (!result.ok || !result.saved) {
        if (result.code !== "ITEM_EXISTS" && result.status !== "forgotten" && result.status !== "disabled") done.failed = result;
        return;
      }
      done.proposed.push(result.item.id);
      if (prior) {
        disputeItem(mem, result.item.id, input.owner, {});
        done.disputed.push(result.item.id);
        if (prior.status === "proposed") {
          disputeItem(mem, prior.id, input.owner, {});
          done.disputed.push(prior.id);
        }
      }
    });
  } catch (error) {
    done.failed = { degraded: true, message: String(error?.message ?? error).slice(0, 200) };
  }
  return done;
}
