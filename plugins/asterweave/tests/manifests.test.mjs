import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const pluginRoot = resolve(repositoryRoot, "plugins", "asterweave");

test("marketplace and plugin manifests agree", () => {
  const marketplace = JSON.parse(readFileSync(resolve(repositoryRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(resolve(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  const entry = marketplace.plugins.find((candidate) => candidate.name === plugin.name);
  assert.ok(entry);
  // plugin.json is the single source of truth for the version; declaring it in the
  // catalog entry as well can mask a newer plugin manifest during resolution.
  assert.equal(entry.version, undefined);
  assert.equal(marketplace.name, "at-digital-labs");
  assert.equal(entry.source, "./plugins/asterweave");
  assert.equal(existsSync(resolve(repositoryRoot, entry.source)), true);
  assert.equal(plugin.defaultEnabled, false);
  assert.equal(plugin.userConfig.github_token.sensitive, true);
});

test("npm test uses the cross-platform test launcher", () => {
  const packageManifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  assert.equal(packageManifest.scripts.test, "node plugins/asterweave/scripts/run-tests.mjs");
  assert.equal(existsSync(resolve(pluginRoot, "scripts", "run-tests.mjs")), true);
  assert.doesNotMatch(packageManifest.scripts.test, /[*?]/);
});

test("GitHub MCP uses sensitive substitution and narrowed toolsets", () => {
  const mcp = JSON.parse(readFileSync(resolve(pluginRoot, ".mcp.json"), "utf8"));
  const github = mcp.mcpServers.github;
  assert.equal(github.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(github.headers.Authorization, "Bearer ${user_config.github_token}");
  assert.notEqual(github.headers["X-MCP-Toolsets"], "all");
  assert.match(github.headers["X-MCP-Toolsets"], /issues|default/);
});

test("Azure DevOps MCP is optional and never embeds a raw secret", () => {
  const mcp = JSON.parse(readFileSync(resolve(pluginRoot, ".mcp.json"), "utf8"));
  const ado = mcp.mcpServers.azuredevops;
  assert.equal(ado.command, "npx");
  assert.deepEqual(ado.args.slice(0, 2), ["-y", "@azure-devops/mcp"]);
  assert.equal(ado.env.PERSONAL_ACCESS_TOKEN, "${user_config.ado_pat_base64}");

  const plugin = JSON.parse(readFileSync(resolve(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.userConfig.ado_organization.required, false);
  assert.equal(plugin.userConfig.ado_pat_base64.sensitive, true);
  assert.equal(plugin.userConfig.ado_pat_base64.required, false);
});
