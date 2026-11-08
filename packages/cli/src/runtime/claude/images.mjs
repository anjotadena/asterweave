// Image input for ONE headless claude turn: the stream-json input message that carries base64 image blocks.
//
// UNVERIFIED: that `claude -p --input-format stream-json` accepts a user message whose content holds `image` blocks with a base64
// source, and the exact field names below, come from the public Anthropic Messages API shape and are NOT confirmed against a
// real Claude Code. Tests run against tests/fixtures/fake-claude.mjs only. Everything shape-specific lives in
// buildStreamJsonInput so a correction touches one function. Never claim a model saw an image.
//
// Image bytes are untrusted data: they go to the child's STDIN only (never argv), are never logged and never put in a ledger event.

import { stringifyJson } from "../../json.mjs";
import { IMAGE_FORMATS, IMAGE_LIMITS } from "../image-format.mjs";
import { ClaudeArgError } from "./argv.mjs";

export const IMAGE_MIMES = Object.freeze(Object.values(IMAGE_FORMATS).map((format) => format.mime));
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Largest base64 text of one allowed image. */
export const MAX_IMAGE_BASE64 = Math.ceil(IMAGE_LIMITS.maxBytes / 3) * 4;

/** Check `images: [{mime, dataBase64}]`. Throws ClaudeArgError (the message never contains image data). */
export function validateImages(images) {
  if (!Array.isArray(images) || images.length === 0 || images.length > IMAGE_LIMITS.perMessage) throw new ClaudeArgError(`images must be a list of 1 to ${IMAGE_LIMITS.perMessage} images`);
  for (const image of images) {
    if (image === null || typeof image !== "object" || !IMAGE_MIMES.includes(image.mime)) throw new ClaudeArgError(`each image needs a mime type of ${IMAGE_MIMES.join(", ")}`);
    if (typeof image.dataBase64 !== "string" || image.dataBase64.length === 0 || image.dataBase64.length > MAX_IMAGE_BASE64 || !BASE64.test(image.dataBase64)) throw new ClaudeArgError("each image needs base64 data within the size limit");
  }
}

/**
 * The ONE stdin line (newline-terminated JSON) of a turn with images: a user message whose content is [image blocks..., text block].
 * UNVERIFIED shape, see the header.
 * @param {{prompt: string, images: {mime: string, dataBase64: string}[]}} input
 * @returns {Buffer}
 */
export function buildStreamJsonInput({ prompt, images }) {
  validateImages(images);
  const content = [
    ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.dataBase64 } })),
    { type: "text", text: prompt },
  ];
  return Buffer.from(`${stringifyJson({ type: "user", message: { role: "user", content } })}\n`, "utf8");
}
