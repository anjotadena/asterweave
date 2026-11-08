// Ctrl-C at the real bin during `asterweave mcp add`: the claude tree is killed, no orphan is left, the neutral temp dir is removed,
// the message says what may have changed and the exit code is 130. POSIX only (a signal sent to a Windows child ends it without running
// handlers). A `claude` executable on PATH is a tiny script that runs the scripted fake in admin mode (hang). Isolated HOME/USERPROFILE/APPDATA.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { alive, cleanup, FAKE_CLAUDE, readJsonFile, tempDir } from "./admin-fixture.mjs";
import { waitFor } from "./repo-fixture.mjs";

after(cleanup);
const BIN = fileURLToPath(new URL("../bin/asterweave.mjs", import.meta.url));

for (const scope of ["global", "repo"]) {
  test(`SIGINT at the real bin during mcp add --scope ${scope}: exit 130, no orphan, temp dir removed`, { skip: process.platform === "win32" ? "signals cannot be delivered to a Windows child" : false }, async () => {
    const repo = tempDir("aw-binint-repo-");
    const home = tempDir("aw-binint-home-");
    const userDir = tempDir("aw-binint-user-");
    const appdata = tempDir("aw-binint-appdata-");
    const scratch = tempDir("aw-binint-sc-");
    const bindir = join(scratch, "bin");
    mkdirSync(bindir);
    const scenario = join(scratch, "scenario.json");
    const record = join(scratch, "record.json");
    writeFileSync(scenario, JSON.stringify({ record, admin: { behavior: "hang", userFile: join(home, ".claude.json") } }));
    const shim = join(bindir, "claude");
    writeFileSync(shim, `#!${process.execPath}\nprocess.argv.splice(2, 0, "--fake-scenario", ${JSON.stringify(scenario)});\nimport(${JSON.stringify(pathToFileURL(FAKE_CLAUDE).href)});\n`);
    chmodSync(shim, 0o755);
    const env = { PATH: `${bindir}${delimiter}${process.env.PATH ?? ""}`, HOME: home, USERPROFILE: home, APPDATA: appdata, ASTERWEAVE_CONFIG_DIR: userDir };
    const child = spawn(process.execPath, [BIN, "mcp", "add", "h", "--scope", scope, "--yes", "--", "node"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk; });
    const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    await waitFor(() => readJsonFile(record) !== null, { timeoutMs: 15000, label: "the fake claude to start" });
    const { pid, cwd } = readJsonFile(record);
    child.kill("SIGINT");
    const result = await exited;
    assert.equal(result.code, 130, err);
    assert.match(err, /Interrupted/);
    if (scope === "repo") assert.match(err, /No file changed|Files changed/);
    for (let i = 0; i < 60 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(pid), false, "the claude process is gone");
    if (scope === "global") assert.ok(!existsSync(cwd), "the private temp directory was removed");
    assert.ok(!existsSync(join(repo, ".mcp.json")));
  });
}
