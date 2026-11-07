// `asterweave doctor [--json]`. Registered by commands/index.mjs.
//
// Exit code: 0 when no check is FAIL, 1 (EXIT.ERROR) when any is. WARN never changes the exit code.
// `--json` writes exactly one JSON object `{ok,checks}` to stdout and nothing else there; stderr is
// left empty (a FAIL is data in the report, not an error message).

import { EXIT, UsageError } from "../exit-codes.mjs";
import { runDoctor } from "../doctor.mjs";
import { stringifyJson } from "../json.mjs";
import { sanitizeForTerminal } from "../redact.mjs";
import { createStyle } from "../tui/render.mjs";
import { colorMode } from "./shared.mjs";

export const doctorCommandMeta = Object.freeze({ summary: "Check installation, auth and repository health", boolean: ["json"], options: ["json"] });

const USAGE = "Usage: asterweave doctor [--json]";

/** Plain-text report: one row per check, remediation under every non-PASS row. */
export function formatDoctorReport(report, style = createStyle({ env: {}, isTTY: false })) {
  const paint = { PASS: style.green, WARN: style.yellow, FAIL: style.red };
  // Reasons and remediations can quote repository/config-controlled text: sanitise the dynamic
  // parts before styling is applied (JSON output is unaffected).
  const safe = (text) => sanitizeForTerminal(text);
  const width = Math.max(...report.checks.map((item) => safe(item.id).length));
  const lines = [];
  for (const item of report.checks) {
    lines.push(`${paint[item.status](safe(item.status))}  ${safe(item.id).padEnd(width)}  ${safe(item.reason)}`);
    if (item.status !== "PASS" && item.remediation) lines.push(`${" ".repeat(6 + width)}-> ${safe(item.remediation)}`);
  }
  const count = (status) => report.checks.filter((item) => item.status === status).length;
  lines.push("", `${report.ok ? "No blocking problems" : "Blocking problems found"}: ${count("PASS")} PASS, ${count("WARN")} WARN, ${count("FAIL")} FAIL`);
  return `${lines.join("\n")}\n`;
}

/** Handler for `asterweave doctor`. */
export async function doctorCommand(ctx) {
  if ((ctx.positionals ?? []).length > 0) throw new UsageError(`Unexpected argument '${sanitizeForTerminal(ctx.positionals[0])}'.`, { remediation: USAGE });
  const options = { env: ctx.env, cwd: ctx.cwd, spawn: ctx.spawn };
  // Test seams, forwarded only when the caller provided them.
  for (const key of ["exists", "platform", "homedir", "now", "nodeVersion", "repoStatus", "fs", "timeoutMs"]) if (ctx[key] !== undefined) options[key] = ctx[key];

  const report = await runDoctor(options);
  if (ctx.options?.json === true) {
    ctx.stdout.write(`${stringifyJson({ ok: report.ok, checks: report.checks })}\n`);
  } else {
    ctx.stdout.write(formatDoctorReport(report, createStyle({ env: ctx.env, isTTY: Boolean(ctx.stdout?.isTTY), mode: colorMode(ctx) })));
  }
  return report.ok ? EXIT.OK : EXIT.ERROR;
}
