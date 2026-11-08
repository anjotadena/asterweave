// `session attach|detach` and the image parts of `session start|show` (split from session.mjs, which passes its helpers in `kit`).
//
// attach: validates EVERY file first (exit 2, nothing written), then stores stripped copies in the session. detach: previews, then asks y/N
// on a terminal or needs --yes (exit 2 otherwise, nothing removed). Output names, formats, sizes, dimensions and hash prefixes; never bytes.

import { EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { sanitizeLines } from "../redact.mjs";
import { describeAttachment, IMAGE_LIMITS, removeAttachment } from "../runtime/attachments.mjs";
import { loadSession } from "../runtime/sessions.mjs";
import { attachInspected, attachmentViews, inspectAll, storeOpts, storeProblemError } from "./images.mjs";

const storeProblem = storeProblemError;

/** Lines for `session show`. */
export function attachmentLines(session) {
  return [`Attachments (${session.attachments.length})`, ...session.attachments.map((attachment) => `  ${describeAttachment(attachment)}${attachment.sentRunId ? `  sent with run ${attachment.sentRunId}` : "  not sent yet"}`)];
}

export async function attachCommand(ctx, kit) {
  const [, id, ...paths] = ctx.positionals;
  kit.check(ctx, "attach", [id, ...paths].filter((x) => x !== undefined), IMAGE_LIMITS.perMessage + 1);
  if (id === undefined || paths.length === 0) throw new UsageError("session attach needs a session id and at least one image path.", { remediation: kit.USAGE });
  const repo = await kit.resolveRepo(ctx);
  const { session } = loadSession(repo.key, id, kit.readOnly(ctx));
  const inspected = inspectAll(paths, ctx);
  const result = attachInspected(session.id, inspected, ctx, repo.key);
  // all or nothing: a problem throws ONE error (one JSON envelope in --json mode) and nothing was stored
  if (result.problem) throw storeProblem(result.problem);
  const views = attachmentViews(result.attachments);
  if (kit.json(ctx)) {
    kit.write(ctx.stdout, `${stringifyJson({ ok: true, sessionId: session.id, attachments: views, duplicates: result.duplicates })}\n`);
  } else {
    const lines = [`Attached ${result.attachments.length} image(s) to session ${session.id}:`, ...result.attachments.map((attachment) => `  ${describeAttachment(attachment)}${result.duplicates.includes(attachment.id) ? "  (already attached)" : ""}`)];
    lines.push("Copies with metadata stripped were stored in the session; the original files were not changed. Nothing is sent until a run starts with this session (run start --session).");
    kit.write(ctx.stdout, `${sanitizeLines(lines)}\n`);
  }
  return EXIT.OK;
}

export async function detachCommand(ctx, kit) {
  const [, id, attachmentId, ...extra] = ctx.positionals;
  kit.check(ctx, "detach", [id, attachmentId, ...extra].filter((x) => x !== undefined), 2);
  if (id === undefined || attachmentId === undefined) throw new UsageError("session detach needs a session id and an attachment id.", { remediation: kit.USAGE });
  const repo = await kit.resolveRepo(ctx);
  const { session } = loadSession(repo.key, id, kit.readOnly(ctx));
  const options = storeOpts(ctx, repo.key);
  const preview = removeAttachment(session.id, attachmentId, options);
  if (!preview.ok) throw storeProblem(preview.problems[0]);
  const lines = [`Detach ${describeAttachment(preview.attachment)} from session ${session.id}?`, "This removes the stored copy in the session; the original file is not touched."];
  let approved = ctx.options?.yes === true;
  if (!approved) {
    if (kit.isInteractive(ctx) && !kit.json(ctx)) {
      const answer = await kit.confirm(ctx, [...lines, "[y/N]"]);
      if (answer.interrupted) return EXIT.INTERRUPTED;
      if (answer.yes !== true) {
        kit.write(ctx.stdout, "Nothing was removed.\n");
        return EXIT.OK;
      }
      approved = true;
    } else if (kit.json(ctx)) {
      kit.write(ctx.stdout, `${stringifyJson({ ok: false, removed: false, error: { code: "USAGE", message: "Pass --yes to detach.", remediation: `asterweave session detach ${session.id} ${preview.attachment.id} --yes` }, attachment: attachmentViews([preview.attachment])[0] })}\n`);
      return EXIT.USAGE;
    } else {
      kit.write(ctx.stdout, `${sanitizeLines([...lines, "Pass --yes to detach."])}\n`);
      return EXIT.USAGE;
    }
  }
  const done = removeAttachment(session.id, attachmentId, { ...options, confirm: true });
  if (!done.ok) throw storeProblem(done.problems[0]);
  if (kit.json(ctx)) kit.write(ctx.stdout, `${stringifyJson({ ok: true, removed: true, sessionId: session.id, attachment: attachmentViews([done.attachment])[0] })}\n`);
  else kit.write(ctx.stdout, `${sanitizeLines(`Detached ${done.attachment.id} from session ${session.id}.`)}\n`);
  return EXIT.OK;
}
