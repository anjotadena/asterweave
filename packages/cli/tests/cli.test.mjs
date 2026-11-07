// Dispatcher wiring: the default registry, injected registries, and the handler context.
import assert from "node:assert/strict";
import test from "node:test";
import { commands, helpText, runCli, usageText } from "../src/cli.mjs";
import { registerAllCommands } from "../src/commands/index.mjs";

function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
}

test("the default registry carries every Phase A command with a summary and detailed help", () => {
  for (const name of ["help", "launch", "doctor", "repo", "auth", "config", "trust"]) {
    const definition = commands.get(name);
    assert.ok(definition, `${name} is registered`);
    assert.equal(typeof definition.handler, "function");
    assert.ok(definition.summary.length > 0);
    assert.ok(definition.helpText, `${name} has help text`);
  }
  const usage = usageText();
  for (const name of ["launch", "doctor", "repo", "auth", "config", "trust"]) assert.match(usage, new RegExp(`^  ${name}\\s`, "m"));
  assert.match(helpText(), /Exit codes:/);
});

test("an injected registry is isolated from the default one", async () => {
  const stdout = sink();
  const stderr = sink();
  assert.equal(await runCli(["doctor"], { stdout, stderr }, { commands: new Map() }), 2);
  assert.match(stderr.text(), /unknown command 'doctor'/);
  // Without a launch command a bare invocation prints help instead of trying to start a session.
  const bare = sink();
  assert.equal(await runCli([], { stdout: bare, stderr: sink() }, { commands: new Map() }), 0);
  assert.match(bare.text(), /^Usage: asterweave <command>/);
  assert.match(bare.text(), /Exit codes:/);
});

test("handlers receive the registry, usage text and any provided test seams", async () => {
  let seen;
  const registry = registerAllCommands(new Map());
  registry.set("probe", { summary: "", boolean: [], handler: (ctx) => { seen = ctx; } });
  const exists = () => true;
  const homedir = () => "/h";
  assert.equal(await runCli(["probe"], { stdout: sink(), stderr: sink(), exists, homedir, platform: "linux" }, { commands: registry }), 0);
  assert.equal(seen.registry, registry);
  assert.equal(seen.usage, helpText(registry));
  assert.equal(seen.exists, exists);
  assert.equal(seen.homedir, homedir);
  assert.equal(seen.platform, "linux");
  assert.ok(!("fs" in seen), "seams that were not provided stay absent");
});

test("--version wins over everything and -h/--help print the full help", async () => {
  const version = sink();
  assert.equal(await runCli(["--version", "doctor"], { stdout: version, stderr: sink() }), 0);
  assert.match(version.text(), /^\d+\.\d+\.\d+\n$/);
  for (const argv of [["--help"], ["-h"], ["help"]]) {
    const stdout = sink();
    assert.equal(await runCli(argv, { stdout, stderr: sink() }), 0);
    assert.equal(stdout.text(), helpText());
  }
});

test("--json errors from any registered command use the shared envelope", async () => {
  const stdout = sink();
  const stderr = sink();
  assert.equal(await runCli(["repo", "bogus", "--json"], { stdout, stderr }), 2);
  assert.equal(stderr.text(), "");
  const body = JSON.parse(stdout.text());
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "USAGE");
});
