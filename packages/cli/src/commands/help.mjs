// `asterweave help [command]` and the per-command help texts. Keep the exit-code table in sync with
// exit-codes.mjs and website/docs/cli/exit-codes.md.

import { EXIT, UsageError } from "../exit-codes.mjs";
import { mcpHelpText } from "./mcp.mjs";

export const helpCommandMeta = Object.freeze({ summary: "Show help for asterweave or one command", boolean: [], options: [] });

/** The stable exit-code table printed by `help`. */
export const EXIT_CODES_TEXT = [
  "Exit codes:",
  "  0    ok",
  "  1    error, or any doctor check FAIL (also an unexpected internal error; the terminal is restored first)",
  "  2    usage error, or an interactive terminal (TTY) is required",
  "  3    authentication required or invalid",
  "  4    repository trust required",
  "  5    configuration invalid (config.json, flags, policy.json, hooks; also launch / repo connect when github.host is not github.com)",
  "  6    approval required: a run is waiting for a human approval or decision",
  "  7    policy denied: the guard or the policy refused an operation",
  "  130  interrupted (Ctrl+C or SIGTERM, a closed input stream, or a sign-in that did not finish; a run is paused and can be resumed)",
  "",
].join("\n");

const block = (lines) => `${lines.join("\n")}\n`;

/** Detailed help per command: usage, flags, JSON shape and the exit codes that command can return. */
export const COMMAND_HELP = Object.freeze({
  launch: block([
    "asterweave (no command) - start the interactive session",
    "",
    "Usage: asterweave",
    "",
    "Needs an interactive terminal. Signs in to GitHub if needed, lets you pick a repository,",
    "then opens the session. A missing model-provider (Claude Code) sign-in is only a warning.",
    "In scripts use a subcommand with --json instead.",
    "",
    "Exit codes: 0 ok · 1 error · 2 not a TTY · 3 GitHub sign-in failed · 5 invalid configuration, or github.host is not github.com · 130 interrupted",
  ]),
  help: block([
    "asterweave help - show help",
    "",
    "Usage: asterweave help [command]",
    "",
    "Exit codes: 0 ok · 2 unknown command",
  ]),
  doctor: block([
    "asterweave doctor - check installation, auth and repository health",
    "",
    "Usage: asterweave doctor [--json]",
    "",
    "Options:",
    "  --json   Print one JSON object and nothing else on stdout",
    "",
    'JSON: {"ok":boolean,"checks":[{"id","status":"PASS|WARN|FAIL","reason","remediation"}]}',
    "Never prints secrets. WARN does not change the exit code.",
    "",
    "Exit codes: 0 no FAIL · 1 at least one FAIL",
  ]),
  repo: block([
    "asterweave repo - connect an existing local clone, or show the connection",
    "",
    "Usage: asterweave repo connect [--repo owner/name] [--branch name] [--path dir] [--json]",
    "       asterweave repo status [--json]",
    "",
    "Options:",
    "  --repo    Repository as owner/name (interactive picker when omitted in a terminal)",
    "  --branch  Branch to connect",
    "  --path    Existing clone (default: current directory); its origin must match --repo",
    "  --json    JSON output; connect then requires --repo and --branch",
    "",
    'JSON (connect): {"ok":true,"repository","branch","path","runner":"local"}',
    "Asterweave never clones, fetches or changes the clone.",
    "",
    "Exit codes: 0 ok · 1 error · 2 usage · 3 not signed in to GitHub · 5 invalid configuration, or github.host is not github.com (connect) · 130 interrupted",
  ]),
  auth: block([
    "asterweave auth - show or change sign-in state",
    "",
    "Usage: asterweave auth status [--json] [--host h]",
    "       asterweave auth login [github|model] [--host h]",
    "       asterweave auth logout <github|model> [--host h] [--json]",
    "",
    "Planes: GitHub (through gh, required), model provider (through claude, optional),",
    "Asterweave account (unavailable: no hosted backend is configured).",
    "",
    "status   Masked view of all three planes. Exit 3 when GitHub is not usable.",
    "login    Hands the terminal to `gh auth login --web` or `claude auth login`.",
    "         Without a plane, an interactive picker is shown (a TTY is required).",
    "logout   Removes Asterweave's stored reference only and prints the provider command to run",
    "         (`gh auth logout -h <host>` / `claude auth logout`). It never signs you out itself.",
    "",
    'JSON (status): {"ok":boolean,"planes":{"asterweave":{},"github":{},"model":{}}}',
    'JSON (logout): {"ok":true,"plane","droppedReference":boolean,"providerCommand"}',
    "Tokens are never read, printed or stored.",
    "",
    "Exit codes: 0 ok · 2 usage · 3 auth required/invalid · 130 interrupted",
  ]),
  config: block([
    "asterweave config - show the effective configuration",
    "",
    "Usage: asterweave config show [--json] [--strict] [--path dir] [--runner local] [--github-host host] [--ui-color auto|always|never]",
    "",
    "  --path    Repository to layer in (default: the connected repository, else the current directory).",
    "  --strict  Exit 4 (TRUST_REQUIRED) when the repository has executable config (quality-gate commands, run hooks,",
    "            Claude Code settings, MCP servers) and is not trusted. Without it those keys are skipped and reported.",
    "",
    "Precedence (lowest to highest): default < user config.json < trusted repo .claude/asterweave.json",
    "  < ASTERWEAVE_* environment < flags. Each key is shown with its origin.",
    "Executable repository fields are skipped (and reported) unless the repository is trusted.",
    "",
    'JSON: {"ok":true,"precedence":[],"entries":{"<key>":{"value","origin"}},"unknown":[],"repo":{...}|null}',
    "",
    "Exit codes: 0 ok · 2 usage · 4 --strict and the repository is untrusted · 5 configuration invalid",
  ]),
  run: block([
    "asterweave run - inspect, approve or abort a run",
    "",
    "Usage: asterweave run show [runId] [--json]",
    "       asterweave run approve <runId> --approval <id> --subject <hash> [--json]",
    "       asterweave run abort <runId> [--yes] [--json]",
    "",
    "Runs are kept per repository (run this command inside the repository; runs live in the Asterweave user directory).",
    "",
    "show     Graph, status, per-node attempts, approvals (with the subject hash prefix), budgets (tokens are",
    "         'unavailable' when unknown, never 0), the run lock and the policy. Without a run id: the newest run.",
    "approve  Records an approval. With flags: --approval <id> and --subject <the hash prefix 'run show' prints, at least",
    "         6 hex characters>. In a terminal without flags: asks y/N for each waiting approval, naming who requested it, the",
    "         scope and the WHOLE target (newline, tab and backslash are shown as \\n \\t \\\\); several answers are applied all or nothing.",
    "         Refused when ASTERWEAVE_RUN_ID is set (advisory, not a security boundary) and when the request was made under a",
    "         policy that is no longer in force (APPROVAL_STALE). Never read from repository files. Inside a run, show hides subjects.",
    "abort    Stops the run for good (already aborted: nothing happens). Asks y/N in a terminal; needs --yes otherwise.",
    "",
    'JSON (show): {"ok":true,"run":{"runId","graph":{"id","version","hash"},"goal","status","currentNode","repo":{"realpath"},',
    '  "createdAt","updatedAt","lastSeq","eventsBehind","nodes":[{"id","status","attempts","maxAttempts","outcome"}],',
    '  "approvals":[{"id","kind","scope":{"operation","target"},"targetLength","displayable","state":"pending|granted|invalidated","valid","subject","requestedBy":"executor|guard|hook"|null,"by","requestedAt","grantedAt","invalidatedAt"}],',
    '  "budgets":{"iterations","toolCalls","tokens","wallMs":{"used","limit"}},"lock":{"state","pid","ageMs"},',
    '  "policy":{"mode","hash","currentHash","changed","error"},"attention":{"decision","reason","ruleId","message","node"}|null}}',
    'JSON (approve): {"ok":true,"runId","approved":[{"id","kind","scope","subject","by","grantedAt"}]}',
    'JSON (abort): {"ok":true,"runId","status":"aborted","alreadyAborted":boolean}',
    "",
    "Exit codes: 0 ok · 1 error (run not found, approval not found / stale / changed / not shown faithfully, run locked by another process,",
    "declined, the work tree git reports is not the repository's) · 2 usage (including a subject that does not match) · 5 invalid policy or",
    "hooks configuration · 130 interrupted",
  ]),
  usage: block([
    "asterweave usage - token usage and budgets of a run (read-only)",
    "",
    "Usage: asterweave usage [runId] [--json]",
    "",
    "Shows measured tokens by counter, node and model, the latest context size and the budgets remaining.",
    "Context size, cumulative usage and budget remaining are separate numbers. A value nobody measured is",
    "'unknown', never 0. Without a run id: the newest run of this repository. Makes no model call.",
    "",
    'JSON: {"ok":true,"runId","usage":{"totals","byNode","byModel","context","budgets"}}',
    "",
    "Exit codes: 0 ok · 1 run not found or unreadable · 2 usage",
  ]),
  model: block([
    "asterweave model - which model each stage uses and why (read-only)",
    "",
    "Usage: asterweave model [show | explain <node>] [--json]",
    "",
    "Shows the route pinned by the newest run against the current configuration (model.default, model.effort,",
    "model.fallback, model.stages.<node>) and flags drift. Availability comes from a static catalog and is",
    "labelled unverified; nothing here talks to a provider.",
    "",
    "Exit codes: 0 ok · 1 error · 2 usage",
  ]),
  mcp: block(mcpHelpText.split("\n")),
  trust: block([
    "asterweave trust - review, grant or revoke trust for a repository",
    "",
    "Usage: asterweave trust [status|grant|revoke] [--path dir] [--json]",
    "",
    "Options:",
    "  --path  Repository (default: the connected repository, else the current directory).",
    "          Required for `grant` outside an interactive terminal.",
    "",
    "Trust is bound to the contents of .claude/asterweave.json, .claude/settings.json,",
    "settings.local.json and .mcp.json; any change makes the repository untrusted again.",
    "Findings list counts and file names, never command text.",
    "",
    'JSON: {"ok":true,"trusted":boolean,"path","hash",...}',
    "",
    "Without --path, trust grant in a terminal asks y/N (default No); the grant is bound to the previewed hash.",
    "A corrupt trust.json is recreated by `trust grant` / `trust revoke` (revoke JSON: removed, recreated);",
    "`trust status` fails with exit 1 on it. Reads in other commands never rewrite it.",
    "",
    "Exit codes: 0 ok · 1 path error, declined, files changed during grant, or corrupt trust store on status · 2 usage · 130 interrupted",
  ]),
});

/** Help for one command, or `undefined` when there is no detailed text. */
export function commandHelp(name) {
  return COMMAND_HELP[name];
}

/** Handler for `asterweave help [command]`. */
export async function helpCommand(ctx) {
  const [target, ...extra] = ctx.positionals ?? [];
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${extra[0]}'.`, { remediation: "Usage: asterweave help [command]" });
  if (target === undefined) {
    ctx.stdout.write(ctx.usage ?? "");
    return EXIT.OK;
  }
  const definition = ctx.registry?.get(target);
  if (!definition) throw new UsageError(`Unknown command '${target}'.`, { remediation: "Run `asterweave help` for the command list." });
  ctx.stdout.write(definition.helpText ?? `asterweave ${target}${definition.summary ? ` - ${definition.summary}` : ""}\n`);
  return EXIT.OK;
}
