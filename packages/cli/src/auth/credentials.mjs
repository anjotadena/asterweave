// Credential REFERENCE store (credentials.json in the user directory). It records which provider
// sign-in Asterweave relies on - never a token. Every reference is checked against a closed
// schema and scanned with the redactor before it is written; anything token-shaped is refused.

import { CliError, EXIT } from "../exit-codes.mjs";
import { userFilePath } from "../paths.mjs";
import { redactText } from "../redact.mjs";
import { readJson, writeJsonAtomic } from "../store.mjs";

export const PLANES = Object.freeze(["asterweave", "github", "model"]);

// provider/source are fixed per plane; `fields` is the complete list of other keys; `required` must be strings.
const SCHEMAS = Object.freeze({
  github: { provider: "github", source: "gh-cli", fields: ["host", "account", "verifiedAt"], required: ["host", "verifiedAt"] },
  model: { provider: "model", source: "claude-cli", fields: ["account", "authMethod"], required: [] },
  asterweave: { provider: "asterweave", source: undefined, fields: ["state"], required: ["state"] },
});

function invalid(message, code = "CREDENTIAL_REFERENCE_INVALID") {
  return new CliError(message, { code, exitCode: EXIT.ERROR });
}

/**
 * Validate and canonicalise a reference. Unknown keys, wrong provider/source, non-string values,
 * and any token-shaped or unmasked-email value are rejected (throws CliError).
 */
export function normalizeReference(plane, reference) {
  const schema = SCHEMAS[plane];
  if (!schema) throw invalid(`Unknown credential plane '${plane}'.`);
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw invalid(`The ${plane} credential reference must be an object.`);
  const allowed = new Set(["provider", ...(schema.source ? ["source"] : []), ...schema.fields]);
  for (const key of Object.keys(reference)) {
    if (!allowed.has(key)) throw invalid(`The ${plane} credential reference may not contain '${key}'.`);
  }
  if (reference.provider !== schema.provider) throw invalid(`The ${plane} credential reference must have provider '${schema.provider}'.`);
  if (schema.source && reference.source !== schema.source) throw invalid(`The ${plane} credential reference must have source '${schema.source}'.`);
  const result = { provider: schema.provider };
  if (schema.source) result.source = schema.source;
  for (const field of schema.fields) {
    const value = reference[field];
    if (value === undefined || value === null) {
      if (schema.required.includes(field)) throw invalid(`The ${plane} credential reference requires '${field}'.`);
      result[field] = null;
      continue;
    }
    if (typeof value !== "string") throw invalid(`The ${plane} credential reference field '${field}' must be a string.`);
    if (redactText(value).count > 0) {
      throw invalid(`Refusing to store a secret-like value in the ${plane} credential reference ('${field}').`, "CREDENTIAL_REFERENCE_SECRET");
    }
    result[field] = value;
  }
  if (plane === "asterweave" && result.state !== "unavailable") throw invalid("The asterweave credential reference state must be 'unavailable'.");
  return result;
}

/** Stored references by plane. Entries that do not pass validation are ignored (never surfaced). */
export function readCredentials(options) {
  const data = readJson(userFilePath("credentials", options), { fallback: null });
  const stored = data && typeof data === "object" ? data.references : null;
  const references = {};
  if (!stored || typeof stored !== "object") return references;
  for (const plane of PLANES) {
    if (stored[plane] === undefined) continue;
    try {
      references[plane] = normalizeReference(plane, stored[plane]);
    } catch {
      // Hand-edited or foreign content: treat as absent.
    }
  }
  return references;
}

function writeReferences(references, options) {
  writeJsonAtomic(userFilePath("credentials", options), { version: 1, references });
}

/** Persist one plane's reference (validated first). Returns the stored reference. */
export function saveReference(plane, reference, options) {
  const normalized = normalizeReference(plane, reference);
  const references = readCredentials(options);
  references[plane] = normalized;
  writeReferences(references, options);
  return normalized;
}

/** Remove one plane's reference. Returns true if one was stored. Writes nothing when absent. */
export function dropReference(plane, options) {
  if (!SCHEMAS[plane]) throw invalid(`Unknown credential plane '${plane}'.`);
  const references = readCredentials(options);
  if (!(plane in references)) return false;
  delete references[plane];
  writeReferences(references, options);
  return true;
}
