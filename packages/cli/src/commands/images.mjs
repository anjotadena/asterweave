// Command-side image helpers for `session attach|start --image` and `run start --image` (not a command itself).
//
// Rules: flags are explicit (nothing is read from the repository or prompted for in a pipe); every file is validated BEFORE anything is
// written or any child starts; what will be sent is printed (name, format, size, dimensions, hash prefix, stripped metadata) and JSON
// output carries hashes and sizes only, never bytes. The images are untrusted data: see website/docs/cli/images.md.

import { CliError, UsageError } from "../exit-codes.mjs";
import { sanitizeForTerminal } from "../redact.mjs";
import { addAttachment, attachmentView, describeAttachment, IMAGE_LIMITS, inspectImage, readAttachmentBytes, removeAttachment } from "../runtime/attachments.mjs";
import { CATALOG, configOfPinned, resolveRoute } from "../runtime/routing.mjs";
import { seams } from "./shared.mjs";

export const IMAGE_REMEDIATION = `Images must be PNG, JPEG or WebP (decided by the file's first bytes), at most ${IMAGE_LIMITS.maxBytes / 1048576} MiB and ${IMAGE_LIMITS.maxDimension} x ${IMAGE_LIMITS.maxDimension} pixels (${IMAGE_LIMITS.maxPixels / 1e6} megapixels); see \`asterweave help session\`.`;

/**
 * Every value of a repeatable `--name` option, read from the raw arguments (the shared parser keeps only the last one).
 * Same consumption rule as the parser: `--name value` takes the next token unless it starts with `--`; `--name=value`.
 */
export function repeatedOption(ctx, name) {
  if (!Array.isArray(ctx.argv)) {
    // no raw arguments (a handler called directly): the parsed option, a single value or a list
    const parsed = ctx.options?.[name];
    return parsed === undefined ? [] : Array.isArray(parsed) ? parsed : [parsed];
  }
  const argv = ctx.argv.map(String);
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") break;
    if (token === `--${name}`) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) values.push(true);
      else {
        values.push(next);
        index += 1;
      }
    } else if (token.startsWith(`--${name}=`)) values.push(token.slice(name.length + 3));
  }
  return values;
}

/** The `--image` values: at least a path each, at most 10. @returns {string[]} */
export function imagePaths(ctx, usage) {
  const values = repeatedOption(ctx, "image");
  if (values.some((value) => typeof value !== "string" || value.trim() === "")) throw new UsageError("--image needs a file path.", { remediation: usage });
  if (values.length > IMAGE_LIMITS.perMessage) throw new UsageError(`At most ${IMAGE_LIMITS.perMessage} images can be sent in one message.`, { remediation: usage });
  return values;
}

export const storeOpts = (ctx, repoKey) => ({ ...seams(ctx), ...(repoKey ? { repoKey } : {}), ...(ctx.cwd ? { cwd: ctx.cwd } : {}), ...(ctx.now ? { now: ctx.now } : {}), ...(ctx.userDir ? { userDir: ctx.userDir } : {}) });

/**
 * Inspect every path; any problem refuses the whole command (exit 2) before anything is written.
 * @returns {{path: string, result: object}[]}  each result is an ok inspectImage result (stripped bytes included, in memory only)
 */
export function inspectAll(paths, ctx) {
  const inspected = paths.map((path) => ({ path, result: inspectImage(path, { ...(ctx.cwd ? { cwd: ctx.cwd } : {}), ...(ctx.fs ? { fs: ctx.fs } : {}) }) }));
  const failures = inspected.filter((item) => !item.result.ok);
  if (failures.length > 0) {
    const lines = failures.flatMap((item) => item.result.problems.map((problem) => `${sanitizeForTerminal(problem.code)}: ${sanitizeForTerminal(problem.message).slice(0, 240)}`));
    throw new UsageError(`${failures.length} image(s) were refused: ${lines.join("; ")}`, { code: "IMAGE_INVALID", remediation: IMAGE_REMEDIATION });
  }
  return inspected;
}

/**
 * Add the (already inspected) images to a session, ALL OR NOTHING: when one fails, the copies this call stored are removed again.
 * @returns {{attachments: object[], duplicates: string[], problem: object|null}}  on a problem, attachments is [] (nothing was kept)
 */
export function attachInspected(sessionId, inspected, ctx, repoKey) {
  const options = storeOpts(ctx, repoKey);
  const attachments = [];
  const duplicates = [];
  const created = [];
  for (const item of inspected) {
    // from the path again (not the stripped copy): the record keeps what was dropped, and the file is re-validated at the moment it is stored
    const added = addAttachment(sessionId, item.path, options);
    if (!added.ok) {
      for (const id of created.reverse()) removeAttachment(sessionId, id, { ...options, confirm: true });
      return { attachments: [], duplicates: [], problem: added.problems[0] };
    }
    if (added.duplicate) duplicates.push(added.attachment.id);
    else created.push(added.attachment.id);
    if (!attachments.some((existing) => existing.id === added.attachment.id)) attachments.push(added.attachment);
  }
  return { attachments, duplicates, problem: null };
}

/** The error for a store problem: exit 2 for TOO_MANY and bad attachment ids (arguments), exit 1 for everything else (archived, write failure...). */
export function storeProblemError(problem, remediation) {
  const usage = ["TOO_MANY", "ATTACHMENT_ID_INVALID", "ATTACHMENT_AMBIGUOUS"].includes(problem.code);
  const Type = usage ? UsageError : CliError;
  const detail = remediation ?? (problem.code === "TOO_MANY" ? "Detach one first: asterweave session detach <id> <attachmentId>" : "See `asterweave session show <id>` for the attachments.");
  return new Type(sanitizeForTerminal(problem.message).slice(0, 300), { code: String(problem.code), remediation: detail });
}

/** The lines that say exactly what will be sent with the first turn. */
export function sendLines(attachments) {
  return [
    `Sending ${attachments.length} image(s) with the first turn of this run (sent with each attempt of the first turn, in a fresh provider session; later turns resume that session and carry no images):`,
    ...attachments.map((attachment) => `  ${describeAttachment(attachment)}`),
    "Stored copies are cleaned of metadata (EXIF, XMP, text chunks) first. The image content is untrusted data; guard and approvals still apply.",
  ];
}

export const attachmentViews = (attachments) => attachments.map(attachmentView);

/**
 * Static-catalog capability check for the images of a run's FIRST node (the route model and its fallbacks).
 * A model that is in the catalog without `images` refuses (the caller exits 2); an unknown or unset model only warns.
 * @returns {{refused: string[], warnings: string[]}}
 */
export function checkImageModel({ routing, node, catalog = CATALOG }) {
  const route = resolveRoute({ config: configOfPinned(routing) ?? { default: null, effort: null, fallback: [], stages: {} }, node, catalog });
  const warnings = [];
  const refused = [];
  if (route.model === null) warnings.push("No model is configured (model.default): the runner chooses its own, so image support is not verified.");
  for (const id of [route.model, ...route.fallbackChain].filter(Boolean)) {
    if (!Object.hasOwn(catalog, id)) warnings.push(`${sanitizeForTerminal(id).slice(0, 80)} is not in the static catalog, so image support is unknown; the images are sent anyway.`);
    else if (catalog[id].features?.images !== true) refused.push(id);
  }
  return { refused, warnings };
}

export function imageModelError(refused) {
  return new UsageError(`The model ${refused.map((id) => sanitizeForTerminal(id).slice(0, 80)).join(", ")} does not list image input in the static catalog, so no image would be sent.`, {
    code: "IMAGE_MODEL_UNSUPPORTED",
    remediation: "Choose a model that lists images (`asterweave model show`, then set model.default or model.stages.<node>), or run without --image.",
  });
}

/** Executor option: the items (hashes and sizes) plus a loader that reads each stored copy and verifies its hash. */
export function imageSource(sessionId, attachments, ctx, repoKey) {
  const options = storeOpts(ctx, repoKey);
  return {
    items: attachments.map((attachment) => ({ id: attachment.id, sha256: attachment.sha256, bytes: attachment.bytes })),
    load: () => attachments.map((attachment) => {
      const read = readAttachmentBytes(sessionId, attachment, options);
      if (!read.ok) throw new Error(read.problems[0].message);
      return { mime: attachment.mime, dataBase64: read.bytes.toString("base64") };
    }),
  };
}
