// Tiny helpers shared by the image parsers (not a public module).

export const fail = (code, message) => ({ ok: false, code, message });
export const ascii = (buf, from, to) => buf.toString("latin1", from, Math.min(to, buf.length));
/** Most structures (segments, chunks, frames) any parser will walk; checked right after each step. */
export const MAX_STRUCTURES = 100_000;

/** null when `width` x `height` is acceptable under `limits`, else a DIMENSIONS failure. */
export function checkDimensions(width, height, limits) {
  if (width < limits.minDimension || height < limits.minDimension) return fail("DIMENSIONS", `the image is ${width} x ${height}; both sides must be at least ${limits.minDimension}`);
  if (width > limits.maxDimension || height > limits.maxDimension) return fail("DIMENSIONS", `the image is ${width} x ${height}; at most ${limits.maxDimension} x ${limits.maxDimension} is accepted`);
  if (width * height > limits.maxPixels) return fail("DIMENSIONS", `the image has ${(width * height / 1e6).toFixed(1)} megapixels; at most ${limits.maxPixels / 1e6} are accepted`);
  return null;
}
