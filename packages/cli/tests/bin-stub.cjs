// Test-only stand-in for `gh` and `claude`, used by bin.test.mjs (not a test file).
//
// POSIX: tiny `gh` / `claude` shell scripts run `node bin-stub.cjs` with STUB_TOOL set.
// Windows: node.exe is copied to gh.exe / claude.exe and this file is injected through NODE_OPTIONS
// (--require); it only acts when the executable's own name is gh or claude, so the real node
// processes that load it are unaffected.
//
// Behaviour comes from environment variables:
//   STUB_GH_HOSTS      stdout of `gh auth status --json hosts`
//   STUB_CLAUDE_STATUS stdout of `claude auth status`
//   STUB_LOGIN_CODE    exit code of `auth login` (default 0)
//   STUB_LOG           file that receives one JSON line per invocation (argv only, never env values)

const fs = require("node:fs");
const path = require("node:path");

const direct = process.env.STUB_TOOL;
const tool = direct || path.basename(process.execPath).replace(/\.exe$/i, "").toLowerCase();

if (tool === "gh" || tool === "claude") {
  const args = direct ? process.argv.slice(2) : [path.basename(process.argv[1] || ""), ...process.argv.slice(2)];
  const tokenShaped = /gh[opurs]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{10,}|sk-ant-[A-Za-z0-9_-]{8,}|Bearer\s+\S{12,}/;
  if (process.env.STUB_LOG) {
    const envHasTokenShaped = Object.values(process.env).some((value) => tokenShaped.test(String(value)));
    fs.appendFileSync(process.env.STUB_LOG, `${JSON.stringify({ tool, args, cwd: process.cwd(), envHasTokenShaped })}\n`);
  }
  const key = args.slice(0, 2).join(" ");
  if (key === "auth login") process.exit(Number(process.env.STUB_LOGIN_CODE || 0));
  if (tool === "gh" && key === "auth status") process.stdout.write(process.env.STUB_GH_HOSTS || "{\"hosts\":{}}");
  else if (tool === "claude" && key === "auth status") process.stdout.write(process.env.STUB_CLAUDE_STATUS || "{\"loggedIn\":false}");
  else process.stderr.write(`stub ${tool}: unsupported arguments\n`);
  process.exit(key === "auth status" ? 0 : 1);
}
