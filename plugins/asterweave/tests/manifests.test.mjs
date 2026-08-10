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
  assert.equal(entry.version, plugin.version);
  assert.equal(entry.source, "./plugins/asterweave");
  assert.equal(existsSync(resolve(repositoryRoot, entry.source)), true);
  assert.equal(plugin.defaultEnabled, false);
  assert.equal(plugin.userConfig.github_token.sensitive, true);
});

test("GitHub MCP uses sensitive substitution and narrowed toolsets", () => {
  const mcp = JSON.parse(readFileSync(resolve(pluginRoot, ".mcp.json"), "utf8"));
  const github = mcp.mcpServers.github;
  assert.equal(github.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(github.headers.Authorization, "Bearer ${user_config.github_token}");
  assert.notEqual(github.headers["X-MCP-Toolsets"], "all");
  assert.match(github.headers["X-MCP-Toolsets"], /issues|default/);
});
