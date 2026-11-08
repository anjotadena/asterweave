// GitHub credential for the pipeline monitor: delegated to the GitHub CLI (`gh auth token -h <host>`), through the injected spawn.
//
// - The token appears nowhere in argv (only the host does), is read from the child's stdout into memory, is validated to be a plain
//   printable token, is cached in memory only, and is never written, logged, or put in an error (errors are fixed text).
// - `gh` missing or not signed in is exit 3 with a remediation. The child environment is gh's (parent environment minus the variables that
//   redirect it) with the host pinned to the requested host.

import { CliError, EXIT } from "../../exit-codes.mjs";
import { runBinary } from "../../proc.mjs";
import { ghEnv } from "../../repo.mjs";

const TOKEN = /^[\x21-\x7e]{8,512}$/;

/**
 * @param {{host: string, env?: object, spawn?: Function, exists?: Function, platform?: string, timeoutMs?: number}} options
 * @returns {{get: () => Promise<string>, ensure: () => Promise<void>}}
 */
export function createTokenReader({ host, env = process.env, spawn, exists, platform, timeoutMs = 15_000 }) {
  let cached = null;
  async function get() {
    if (cached !== null) return cached;
    const result = await runBinary("gh", ["auth", "token", "-h", host], { env: { ...ghEnv(env), GH_HOST: host }, spawn, exists, platform, timeoutMs, maxOutputBytes: 4096 });
    if (result.error) {
      const missing = result.error.code === "NOT_FOUND" || result.error.code === "SHELL_SHIM_ONLY" || result.error.code === "ENOENT";
      throw new CliError(missing ? "The GitHub CLI (gh) was not found." : "The GitHub CLI could not be run to read the sign-in.", {
        code: missing ? "GH_NOT_INSTALLED" : "GH_TOKEN_FAILED",
        exitCode: EXIT.AUTH,
        remediation: missing ? "Install the GitHub CLI from https://cli.github.com/ and run: gh auth login --web -h " + host : "Check that `gh --version` works and retry.",
      });
    }
    const text = String(result.stdout ?? "").trim();
    if (result.code !== 0 || !TOKEN.test(text)) {
      throw new CliError(`Not signed in to ${host} (the GitHub CLI has no usable token).`, { code: "GH_NOT_AUTHENTICATED", exitCode: EXIT.AUTH, remediation: `Run: gh auth login --web -h ${host} -s repo,read:org` });
    }
    cached = text;
    return cached;
  }
  return { get, ensure: async () => void (await get()) };
}
