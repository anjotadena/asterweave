// The CLI test suite needs Node.js 22+ (node:test features and APIs the CLI itself requires), while the
// repository root keeps `engines.node >=18` for the plugin scripts. run-tests.mjs checks this first so a
// too-old Node fails with a clear message instead of a confusing stack trace.

export const MIN_NODE_MAJOR = 22;

/**
 * @param {string} [version]  A `process.versions.node` style string.
 * @returns {{ok: boolean, message?: string}}
 */
export function checkNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return { ok: true };
  return {
    ok: false,
    message: `The Asterweave CLI tests need Node.js ${MIN_NODE_MAJOR} or newer (this is Node.js ${version}). Install Node.js ${MIN_NODE_MAJOR}+ and run \`npm run test:cli\` again.`,
  };
}
