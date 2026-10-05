#!/usr/bin/env node

// Launcher for the optional Azure DevOps MCP server.
//
// Azure DevOps is opt-in (`provider.workItems: azure-devops`), but a plugin's .mcp.json starts
// every server on every session. Started with an empty organization, `@azure-devops/mcp` exits and
// Claude Code reports a failed connection on each session for users who never use Azure DevOps.
// When `ado_organization` is unset this launcher answers the MCP handshake itself with no tools
// and an explanation instead; when it is set, it runs the official server unchanged.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;
const FALLBACK_PROTOCOL = "2025-06-18";
const UNCONFIGURED =
  "Azure DevOps is not configured for Asterweave, so this server exposes no tools. Set the plugin's ado_organization and ado_pat_base64 options and restart Claude Code to enable it.";

// Unset plugin options may arrive empty or as the unexpanded `${user_config.*}` placeholder.
export function resolveOrganization(value) {
  const organization = typeof value === "string" ? value.trim() : "";
  if (!organization || organization.startsWith("${")) return { configured: false };
  if (!ORGANIZATION.test(organization)) return { configured: false, invalid: organization };
  return { configured: true, organization };
}

export function respond(message) {
  if (!message || typeof message !== "object" || message.id === undefined || message.id === null) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "asterweave-azuredevops", version: "0.0.0-unconfigured" },
        instructions: UNCONFIGURED,
      });
    case "tools/list":
      return reply({ tools: [] });
    case "ping":
      return reply({});
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `${message.method} is unavailable: ${UNCONFIGURED}` } };
  }
}

function serveUnconfigured() {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      return;
    }
    const reply = respond(message);
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}

function runOfficial(organization) {
  // On Windows npx is a .cmd shim that needs a shell; the organization is validated above, so it
  // cannot inject shell syntax.
  const child = spawn("npx", ["-y", "@azure-devops/mcp", organization, "--authentication", "pat"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
  child.on("error", (error) => {
    process.stderr.write(`asterweave: could not start @azure-devops/mcp: ${error.message}\n`);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = resolveOrganization(process.argv[2]);
  if (target.invalid) process.stderr.write(`asterweave: ignoring invalid Azure DevOps organization '${target.invalid}'.\n`);
  if (target.configured) runOfficial(target.organization);
  else serveUnconfigured();
}
