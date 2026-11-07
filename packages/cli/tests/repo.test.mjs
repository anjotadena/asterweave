import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { CliError, EXIT } from "../src/exit-codes.mjs";
import { connectRepository, listBranches, listRepositories, parseGithubRemote, readOrigin, repoFilePath, repoStatus, sanitizeRemoteUrl } from "../src/repo.mjs";
import { cleanupTemp, fakeSpawn, ghReply, git, makeClone, snapshot, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const secret = ["ghp", "_", "Z".repeat(36)].join("");

function setup(cloneOptions) {
  const configDir = tempDir("aw-cfg-");
  const clone = makeClone(cloneOptions);
  const options = { env: { ...process.env, ASTERWEAVE_CONFIG_DIR: configDir } };
  return { configDir, clone, options, recordFile: join(configDir, "repo.json") };
}

const rejectsWith = async (promise, code, exitCode = EXIT.ERROR) =>
  assert.rejects(promise, (error) => error instanceof CliError && error.code === code && error.exitCode === exitCode && Boolean(error.remediation || exitCode === EXIT.ERROR));

// ---------------------------------------------------------------------------------------------

test("parseGithubRemote handles https, ssh, scp-like, with and without .git, any host case", () => {
  const expected = { host: "github.com", owner: "acme", name: "widgets", nameWithOwner: "acme/widgets" };
  for (const url of [
    "https://github.com/acme/widgets",
    "https://github.com/acme/widgets.git",
    "https://github.com/acme/widgets/",
    "HTTPS://GitHub.COM/acme/widgets.git",
    "http://github.com/acme/widgets.git",
    "git@github.com:acme/widgets.git",
    "git@github.com:acme/widgets",
    "github.com:acme/widgets.git",
    "ssh://git@github.com/acme/widgets.git",
    "ssh://git@github.com:22/acme/widgets.git",
    "ssh://git@ssh.github.com:443/acme/widgets.git",
    "git://github.com/acme/widgets.git",
    "https://user:pass@github.com/acme/widgets.git",
    `https://x-access-token:${secret}@github.com/acme/widgets.git`,
    `https://${secret}@github.com/acme/widgets.git?x=1#frag`,
  ]) {
    assert.deepEqual({ ...parseGithubRemote(url), host: "github.com" }, expected, url);
  }
  assert.equal(parseGithubRemote("git@GITHUB.COM:Acme/Widgets.git")?.nameWithOwner, "Acme/Widgets");
});

test("parseGithubRemote rejects non-GitHub and malformed remotes and never returns credentials", () => {
  for (const url of [
    "https://gitlab.com/acme/widgets.git",
    "git@bitbucket.org:acme/widgets.git",
    "https://github.com/acme",
    "https://github.com/acme/widgets/extra",
    "https://github.com.evil.example/acme/widgets.git",
    "file:///srv/git/widgets.git",
    "C:\\work\\widgets",
    "/srv/git/widgets.git",
    "",
    "   ",
    null,
    undefined,
    42,
  ]) {
    assert.equal(parseGithubRemote(url), null, String(url));
  }
  const parsed = parseGithubRemote(`https://user:${secret}@github.com/acme/widgets.git`);
  assert.equal(JSON.stringify(parsed).includes(secret), false);
  assert.equal(JSON.stringify(parsed).includes("user"), false);
});

test("sanitizeRemoteUrl strips credentials, query and fragments", () => {
  assert.equal(sanitizeRemoteUrl(`https://user:${secret}@github.com/acme/widgets.git`), "https://github.com/acme/widgets.git");
  assert.equal(sanitizeRemoteUrl(`https://${secret}@github.com/acme/widgets.git?a=b#c`), "https://github.com/acme/widgets.git");
  assert.equal(sanitizeRemoteUrl("git@github.com:acme/widgets.git"), "github.com:acme/widgets.git");
  assert.equal(sanitizeRemoteUrl("C:\\work\\widgets"), "<unrecognized remote>");
});

// --- git inspection on a real repository ------------------------------------------------------

test("listBranches de-duplicates origin/x, drops origin/HEAD, and puts the default first", async () => {
  const { clone, options } = setup();
  const before = snapshot(clone);
  const branches = await listBranches(clone, options);
  assert.equal(branches[0], "main");
  assert.deepEqual([...branches].sort(), ["dev", "feature/x", "main", "release"]);
  assert.equal(new Set(branches).size, branches.length);
  assert.ok(branches.every((name) => !name.startsWith("origin") && name !== "HEAD"));
  assert.equal((await listBranches(clone, { ...options, defaultBranch: "dev" }))[0], "dev");
  assert.equal((await listBranches(clone, { ...options, defaultBranch: "does-not-exist" }))[0], "main");
  assert.deepEqual(snapshot(clone), before);
});

test("readOrigin returns a credential-free url and the parsed repository", async () => {
  const { clone, options } = setup();
  const origin = await readOrigin(clone, options);
  assert.equal(origin.url, "https://github.com/acme/widgets.git");
  assert.equal(origin.github.nameWithOwner, "acme/widgets");

  const withSecret = setup({ origin: `https://user:${secret}@github.com/acme/widgets.git` });
  const hidden = await readOrigin(withSecret.clone, withSecret.options);
  assert.equal(hidden.url, "https://github.com/acme/widgets.git");
  assert.equal(JSON.stringify(hidden).includes(secret), false);

  const none = setup({ origin: null });
  assert.equal(await readOrigin(none.clone, none.options), null);
});

// --- connectRepository --------------------------------------------------------------------------

test("connectRepository records the connection without touching the clone", async () => {
  const { clone, options, recordFile } = setup();
  const before = snapshot(clone);
  const result = await connectRepository({ repository: "acme/widgets", branch: "dev", path: clone, ...options, now: () => "2026-01-02T03:04:05.000Z" });
  assert.deepEqual(result, { ok: true, repository: "acme/widgets", branch: "dev", path: clone, runner: "local", connectedAt: "2026-01-02T03:04:05.000Z", dirty: null });
  assert.deepEqual(JSON.parse(readFileSync(recordFile, "utf8")), { repository: "acme/widgets", branch: "dev", path: clone, runner: "local", connectedAt: "2026-01-02T03:04:05.000Z" });
  assert.equal(repoFilePath(options), recordFile);
  assert.deepEqual(snapshot(clone), before, "HEAD, branch, work tree, refs and config are unchanged");
  assert.equal(snapshot(clone).branch, "main", "connecting to 'dev' did not check it out");
});

test("connectRepository accepts branches that exist only on origin, case-insensitive repository, and subdirectories", async () => {
  const { clone, options, recordFile } = setup();
  const sub = join(clone, "src");
  mkdirSync(sub);
  const result = await connectRepository({ repository: "ACME/Widgets", branch: "release", path: sub, ...options });
  assert.equal(result.branch, "release");
  assert.equal(result.path, clone, "records the work-tree root");
  assert.equal(JSON.parse(readFileSync(recordFile, "utf8")).repository, "ACME/Widgets");
});

test("a dirty work tree is never inspected (dirty: null) and never cleaned", async () => {
  const { clone, options } = setup();
  writeFileSync(join(clone, "README.md"), "changed\n");
  writeFileSync(join(clone, "untracked.txt"), "x\n");
  const before = snapshot(clone);
  assert.notEqual(before.status, "");
  const result = await connectRepository({ repository: "acme/widgets", branch: "main", path: clone, ...options });
  assert.equal(result.dirty, null, "work-tree state is unknown by design: hashing it would run repository filter drivers");
  assert.deepEqual(snapshot(clone), before);
  assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "changed\n");
  assert.equal(existsSync(join(clone, "untracked.txt")), true);
});

test("origin mismatch fails with REPO_ORIGIN_MISMATCH and writes nothing", async () => {
  const { clone, options, recordFile } = setup();
  const before = snapshot(clone);
  await assert.rejects(connectRepository({ repository: "acme/other", branch: "main", path: clone, ...options }), (error) => {
    assert.equal(error.code, "REPO_ORIGIN_MISMATCH");
    assert.equal(error.exitCode, EXIT.ERROR);
    assert.match(error.message, /acme\/widgets/);
    assert.ok(error.remediation);
    return true;
  });
  assert.equal(existsSync(recordFile), false);
  assert.deepEqual(snapshot(clone), before);
});

test("non-GitHub origin and missing origin are rejected", async () => {
  const gitlab = setup({ origin: "https://gitlab.com/acme/widgets.git" });
  await rejectsWith(connectRepository({ repository: "acme/widgets", branch: "main", path: gitlab.clone, ...gitlab.options }), "REPO_ORIGIN_MISMATCH");
  const none = setup({ origin: null });
  await rejectsWith(connectRepository({ repository: "acme/widgets", branch: "main", path: none.clone, ...none.options }), "REPO_NO_ORIGIN");
  assert.equal(existsSync(none.recordFile), false);
});

test("unknown branch fails with REPO_BRANCH_NOT_FOUND", async () => {
  const { clone, options, recordFile } = setup();
  await rejectsWith(connectRepository({ repository: "acme/widgets", branch: "nope", path: clone, ...options }), "REPO_BRANCH_NOT_FOUND");
  assert.equal(existsSync(recordFile), false);
});

test("invalid inputs, missing paths and non-repositories are rejected without writing", async () => {
  const { clone, options, recordFile } = setup();
  const plain = tempDir("aw-plain-");
  await rejectsWith(connectRepository({ repository: "not-a-repo", branch: "main", path: clone, ...options }), "REPO_INVALID", EXIT.USAGE);
  await rejectsWith(connectRepository({ repository: "acme/widgets", branch: "--upload-pack=evil", path: clone, ...options }), "REPO_BRANCH_INVALID", EXIT.USAGE);
  await rejectsWith(connectRepository({ repository: "acme/widgets", branch: "", path: clone, ...options }), "REPO_BRANCH_INVALID", EXIT.USAGE);
  await rejectsWith(connectRepository({ repository: "acme/widgets", branch: "main", path: join(plain, "missing"), ...options }), "REPO_PATH_INVALID");
  await rejectsWith(connectRepository({ repository: "acme/widgets", branch: "main", path: plain, ...options }), "REPO_NOT_GIT");
  assert.equal(existsSync(recordFile), false);
});

test("a git binary that is missing maps to GIT_NOT_INSTALLED", async () => {
  const { clone, options } = setup();
  await rejectsWith(connectRepository({ repository: "acme/widgets", branch: "main", path: clone, ...options, exists: () => false }), "GIT_NOT_INSTALLED");
});

test("credentials embedded in the origin URL never reach errors, results or repo.json", async () => {
  const ok = setup({ origin: `https://x-access-token:${secret}@github.com/acme/widgets.git` });
  const result = await connectRepository({ repository: "acme/widgets", branch: "main", path: ok.clone, ...ok.options });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(readFileSync(ok.recordFile, "utf8").includes(secret), false);

  const bad = setup({ origin: `https://x-access-token:${secret}@github.com/acme/other.git` });
  await assert.rejects(connectRepository({ repository: "acme/widgets", branch: "main", path: bad.clone, ...bad.options }), (error) => {
    assert.equal(error.code, "REPO_ORIGIN_MISMATCH");
    assert.equal(`${error.message}\n${error.remediation}\n${JSON.stringify(error)}`.includes(secret), false);
    return true;
  });

  const odd = setup({ origin: `https://user:${secret}@example.com/team/tools.git` });
  await assert.rejects(connectRepository({ repository: "acme/widgets", branch: "main", path: odd.clone, ...odd.options }), (error) => {
    assert.equal(error.code, "REPO_ORIGIN_MISMATCH");
    assert.equal(`${error.message}\n${error.remediation}`.includes(secret), false);
    assert.match(error.message, /example\.com/);
    return true;
  });
});

// --- repoStatus -----------------------------------------------------------------------------------

test("repoStatus reports not connected, connected, branch drift, trust, and a vanished path", async () => {
  const { clone, options, recordFile } = setup();
  assert.deepEqual(await repoStatus(options), { ok: true, connected: false });

  await connectRepository({ repository: "acme/widgets", branch: "main", path: clone, ...options });
  let status = await repoStatus(options);
  assert.equal(status.ok, true);
  assert.equal(status.connected, true);
  assert.deepEqual({ repository: status.repository, branch: status.branch, currentBranch: status.currentBranch, path: status.path, runner: status.runner, dirty: status.dirty }, { repository: "acme/widgets", branch: "main", currentBranch: "main", path: clone, runner: "local", dirty: null });
  assert.deepEqual(status.trust, { trusted: false, reason: "NOT_GRANTED" });

  git(clone, "checkout", "dev");
  status = await repoStatus(options);
  assert.equal(status.currentBranch, "dev");
  assert.equal(status.branch, "main");
  writeFileSync(join(clone, "new.txt"), "x");
  assert.equal((await repoStatus(options)).dirty, null);

  const record = JSON.parse(readFileSync(recordFile, "utf8"));
  writeFileSync(recordFile, JSON.stringify({ ...record, path: join(clone, "gone") }));
  status = await repoStatus(options);
  assert.deepEqual({ ok: status.ok, connected: status.connected, problem: status.problem }, { ok: false, connected: true, problem: "REPO_PATH_MISSING" });

  writeFileSync(recordFile, JSON.stringify({ ...record, path: tempDir("aw-plain-") }));
  assert.equal((await repoStatus(options)).problem, "REPO_NOT_GIT");
});

test("repoStatus degrades an invalid or corrupt repo.json to 'not connected' with a warning and never rewrites it", async () => {
  const { options, recordFile } = setup();
  const invalid = JSON.stringify({ repository: "nope", branch: "", path: "" });
  writeFileSync(recordFile, invalid);
  let status = await repoStatus(options);
  assert.equal(status.connected, false);
  assert.equal(status.ok, true);
  assert.match(status.warning, /unreadable or invalid/);
  assert.equal(readFileSync(recordFile, "utf8"), invalid, "a read never rewrites the file");
  writeFileSync(recordFile, "{not json");
  status = await repoStatus(options);
  assert.equal(status.connected, false);
  assert.match(status.warning, /repo\.json/);
  assert.equal(readFileSync(recordFile, "utf8"), "{not json");
  rmSync(recordFile);
  status = await repoStatus(options);
  assert.equal(status.connected, false);
  assert.equal(status.warning, undefined);
});

test("repoStatus treats an unreadable trust.json as untrusted with a warning (trust decisions stay closed)", async () => {
  const { options, recordFile, clone, configDir } = setup();
  writeFileSync(recordFile, JSON.stringify({ repository: "acme/widgets", branch: "main", path: clone, runner: "local" }));
  writeFileSync(join(configDir, "trust.json"), "{ broken");
  const status = await repoStatus(options);
  assert.equal(status.ok, true);
  assert.equal(status.trust.trusted, false);
  assert.equal(status.trust.reason, "STORE_UNREADABLE");
  assert.match(status.trust.warning, /^trust store unreadable: run asterweave trust revoke\/grant to recreate$/);
  assert.equal(readFileSync(join(configDir, "trust.json"), "utf8"), "{ broken");
});

// --- gh repo list ---------------------------------------------------------------------------------

function ghSetup(reply, extra = {}) {
  const configDir = tempDir("aw-cfg-");
  const spawn = fakeSpawn(reply);
  return { configDir, spawn, options: { env: { PATH: configDir, ASTERWEAVE_CONFIG_DIR: configDir }, spawn, exists: () => true, ...extra } };
}

test("listRepositories runs gh without a shell in the user dir and normalises the JSON", async () => {
  const body = JSON.stringify([
    { nameWithOwner: "acme/widgets", defaultBranchRef: { name: "main" } },
    { nameWithOwner: "acme/empty", defaultBranchRef: null },
    { nameWithOwner: "bad name/../x", defaultBranchRef: { name: "main" } },
    { nope: true },
  ]);
  const { spawn, options, configDir } = ghSetup(ghReply({ stdout: body }));
  const repos = await listRepositories({ ...options, limit: 50 });
  assert.deepEqual(repos, [{ nameWithOwner: "acme/widgets", defaultBranch: "main" }, { nameWithOwner: "acme/empty", defaultBranch: null }]);
  const [call] = spawn.calls;
  assert.deepEqual(call.args, ["repo", "list", "--json", "nameWithOwner,defaultBranchRef", "--limit", "50"]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.cwd, configDir);
  assert.ok(!call.args.some((arg) => /token/i.test(arg)));
});

test("listRepositories defaults the limit and clamps bad values", async () => {
  for (const [limit, expected] of [[undefined, "100"], [0, "100"], [-3, "100"], [2.5, "100"], [5000, "1000"]]) {
    const { spawn, options } = ghSetup(ghReply({ stdout: "[]" }));
    assert.deepEqual(await listRepositories({ ...options, limit }), []);
    assert.equal(spawn.calls[0].args.at(-1), expected);
  }
});

test("listRepositories maps a missing gh to GH_NOT_INSTALLED and a shim-only gh to GH_SHELL_SHIM_ONLY", async () => {
  const missing = ghSetup(ghReply({ stdout: "[]" }), { exists: () => false });
  await assert.rejects(listRepositories(missing.options), (error) => error.code === "GH_NOT_INSTALLED" && error.exitCode === EXIT.ERROR && /cli\.github\.com/.test(error.remediation));
  assert.equal(missing.spawn.calls.length, 0);

  const shim = ghSetup(ghReply({ stdout: "[]" }), {
    platform: "win32",
    fs: { mkdirSync() {} },
    exists: (file) => file.toLowerCase().endsWith("gh.cmd"),
    env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD", APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
  });
  await assert.rejects(listRepositories(shim.options), (error) => error.code === "GH_SHELL_SHIM_ONLY" && error.exitCode === EXIT.ERROR);
  assert.equal(shim.spawn.calls.length, 0);
});

test("listRepositories maps unauthenticated gh to GH_NOT_AUTHENTICATED with exit 3", async () => {
  for (const stderr of ["To get started with GitHub CLI, please run:  gh auth login", "HTTP 401: Bad credentials (https://api.github.com/graphql)", "You are not logged into any GitHub hosts."]) {
    const { options } = ghSetup(ghReply({ stderr, code: 4 }));
    await assert.rejects(listRepositories(options), (error) => error.code === "GH_NOT_AUTHENTICATED" && error.exitCode === EXIT.AUTH && /gh auth login --web -h github\.com/.test(error.remediation));
  }
});

test("other gh failures are GH_REPO_LIST_FAILED with redacted, bounded output", async () => {
  const { options } = ghSetup(ghReply({ stderr: `boom ${secret} ${"x".repeat(500)}`, code: 1 }));
  await assert.rejects(listRepositories(options), (error) => {
    assert.equal(error.code, "GH_REPO_LIST_FAILED");
    assert.equal(error.exitCode, EXIT.ERROR);
    assert.equal(error.message.includes(secret), false);
    assert.ok(error.message.length < 320);
    return true;
  });
  const garbage = ghSetup(ghReply({ stdout: "<html>" }));
  await rejectsWith(listRepositories(garbage.options), "GH_OUTPUT_UNPARSEABLE");
  const shape = ghSetup(ghReply({ stdout: "{}" }));
  await rejectsWith(listRepositories(shape.options), "GH_OUTPUT_UNPARSEABLE");
});
