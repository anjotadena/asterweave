---
sidebar_position: 13
title: Image attachments
description: "Attach PNG, JPEG and WebP images to a session or a run: accepted formats, the limits (guesses), what is stripped, exactly what is sent and when, trust, and what is still unverified."
---

# Image attachments

You can attach images to a [session](/cli/sessions) and send them with the first turn of a [Claude runner](/cli/runner) run.

```text
asterweave session attach <id> <path>... [--json]
asterweave session detach <id> <attachmentId> [--yes] [--json]
asterweave session start [--image <path>]... [--json]
asterweave run start <goal> [--image <path>]... [--session <id>] [--json]
```

`--image` may be repeated (up to 10 per message). Nothing is read from the repository, nothing is prompted for in a pipe, and no image is ever sent unless you named it (or attached it to the session you start the run in).

:::caution Unverified
The input shape used to hand images to `claude -p` (a stream-json user message with base64 image blocks, `--input-format stream-json`) is **a guess** taken from the public API shape. It has **not** been checked against a real Claude Code, and the tests run only against a stand-in. Asterweave never claims that a model saw an image: it can only say what it handed to the child process. See [Unverified](#unverified).
:::

## Formats

PNG, JPEG and WebP only. The format is decided by the file's **first bytes**, never by the extension or a claimed type: a PNG named `photo.jpg` is a PNG, and a GIF named `photo.png` is refused. GIF, SVG, BMP, TIFF, HEIC/AVIF, PDF and anything unrecognised are refused with a message that names what the file looks like.

Only the file header structure is read (PNG chunks, JPEG segments, WebP chunks) to get the size. Pixels are never decoded.

## Limits

These are **conservative guesses made by this tool, not documented provider limits**.

| Limit | Value |
| --- | --- |
| Size of one file | 5 MiB (checked before the file is read, and again while reading, so a growing file cannot slip past) |
| Dimensions | 1 to 8000 pixels per side |
| Pixels | at most 40 megapixels (a decompression-bomb guard; judged from the headers) |
| Images per message | 10 |
| Images per session | 20 |
| Structures per file | at most 100,000 chunks, segments or frames; a file with more is refused (a marker flood costs no memory) |

The dimensions are checked wherever the file states them: the PNG header, the JPEG frame header (a second or hierarchical frame header is refused), the WebP canvas **and** every image bitstream inside it (a bitstream that disagrees with the canvas, or that is larger than the limits, is refused).

**Animated WebP is refused**: every frame declares its own size, so a tiny file could declare an unbounded number of pixels (a per-image pixel limit cannot express that). Use a still image.

Also refused: directories, devices, pipes (only regular files are opened; a symbolic link is followed only because you named it, and is resolved with `realpath`), Windows device paths (`\\.\...`, `\\?\...`) and UNC network paths (checked on the path you give, on the result of resolving a symbolic link, and on the resolved parent directory, so a junction cannot lead there either), empty files, truncated images, and malformed headers. Every file is checked **before** anything is written or any `claude` process starts: one bad file refuses the whole command (exit 2) and nothing is stored.

## What is stripped

A copy with the metadata removed is stored; the original file is never changed. Stripping is an **allowlist**: a structure survives only when the image needs it **and** its size is exactly what its type allows, so a kept structure cannot carry free text. Everything else is dropped and reported (`dropped`), or the file is refused.

| Format | Kept | Dropped |
| --- | --- | --- |
| PNG | `IHDR`, `IDAT`, `IEND`, `gAMA`, `cHRM`, `sRGB`, `pHYs`, and, with exact sizes for the image's colour type, `sBIT`, `bKGD`, `tRNS` (within the palette); `PLTE` only for palette images (colour type 3) | `eXIf`, `tEXt`, `iTXt`, `zTXt`, `tIME`, `iCCP` (colour profile), a palette in a non-palette image, `tRNS` where it cannot apply, and every other ancillary chunk (including animation chunks: you get the still image). An unknown critical chunk refuses the file |
| JPEG | quantisation and Huffman tables, one frame header, scan headers and image data, restart interval, arithmetic conditioning (only in arithmetic-coded files, with in-range values, each table once), a **rewritten minimal JFIF** header (no thumbnail), a **normalised Adobe APP14** (only its colour transform byte, which decoders need) | EXIF and XMP (APP1, which carries GPS), the ICC profile and every other APP2, IPTC (APP13), comments, every other APPn, JPGn, JFXX and non-JFIF APP0, JFIF thumbnails, anything else in the Adobe segment |
| WebP | `VP8X` (only the alpha flag and the canvas size survive), `ALPH`, and exactly one `VP8 ` / `VP8L` | `EXIF`, `XMP `, `ICCP`, every unknown chunk, the reserved VP8X bytes |

Data after the end marker of the image (a "polyglot": an archive appended to a picture) is **cut off** and reported as `trailing-data`. Table sizes are validated exactly (a quantisation table must be exactly its tables), and TEM or restart markers outside image data are refused. The stripped result is parsed again and must have the same format and size, otherwise the image is refused.

The record keeps `metadataStripped: true` and the kinds that were found (`dropped`). Kept structures carry only decodable fields with the exact sizes and value ranges their type allows, but the **pixel and entropy-coded data, and the numeric values of tables and bitstreams, are not inspected**: a covert channel hidden in them (for example in the low bits of pixels or in table values) is not removed. Two side effects to know about: removing EXIF removes the orientation tag, so a rotated photo may appear rotated, and dropping the ICC profile can shift colours of images that use a non-sRGB profile. Stripping removes metadata, not what the picture shows, and it cannot remove anything hidden inside the compressed pixel data itself.

## What is stored

`<user directory>/sessions/<repo>/<session id>/attachments/<sha256>.<ext>`: content addressed, written atomically with mode 0600, deduplicated (the same picture attached twice is one file). The session records only metadata: `id` (`img_` plus 12 hex digits of the hash), `sha256`, format, mime, bytes, width, height, a sanitized file name (80 characters at most), when it was added, what was stripped, the run that **claimed** it and the run that **sent** it. Image bytes never appear in `session.json`, `events.jsonl`, the run ledger or any JSON output. This directory is inside the user directory, which the [guard](/cli/policy-and-guards) already protects from the agent.

Attaching several images is **all or nothing**: when one cannot be stored, the copies stored by the same command are removed again.

Older session records without attachments load as an empty list. A session `fork` starts with none. `session detach` removes one stored copy after a preview and refuses while an open run has claimed or sent it. `session clean` removes attachments together with the session.

## What is sent, and when

Before the first turn, `run start` prints exactly what it will send: name, format, size, dimensions, a hash prefix and what was stripped. In JSON mode the same facts appear as `attachments` (hashes and sizes only) in the result.

- Images travel on the child's **standard input** as one message; they never appear in a command line.
- The run **claims** its images before the first turn, so they cannot be detached while the run is open, and another run does not take them. The claim is a compare-and-set under the session lock: an image already held by another open run is skipped (the run prints "N staged image(s) are held by open run R") unless you named it with `--image`.
- They go with the **first successful turn** of the run. Every attempt of that first turn starts a **fresh provider session** and carries the images: if the first turn fails (for example a rate limit) and the run falls back, the retry sends them again in another fresh session, and a failed image turn is never resumed. Later turns resume the session of the successful turn and carry no images.
- If the first turn never succeeded (the node was blocked, the run interrupted), `run resume <runId>` sends the images that run claimed and did not manage to send, with the same printout and model check. Once a turn has delivered them, nothing is sent again.
- With `--session <id>`, images attached to that session that are not yet sent and not claimed by another open run go with the run's first turn, together with any `--image` paths. Naming an already-sent image with `--image` sends it again.
- The ledger gets one `attachments.sent` event per attempt that carried images: node, count, total bytes, the first 12 hex digits of each hash, and whether the turn succeeded. No bytes.

`run start --image` stores the copies in a session (a new one is created when you give neither `--session` nor `--worktree`), so there is always one place to look at them with `session show`. The run is created first: a failure such as a duplicate `--run-id` leaves no session and no stored copy behind.

### Model check

The model routed to the first stage (and its fallbacks) must list `images` in the **static** [model catalog](/cli/tools-usage-routing); otherwise the command exits 2 with a remediation and nothing is created. The check is applied to the list that will actually be sent. A model that is not in the catalog, or no configured model at all, only prints a warning: the images are sent anyway, because the catalog is a static list and nothing here checks a live service.

## Trust

Images are **untrusted data**. A model may follow instructions that are written inside an image. Nothing about that changes the guard: the PreToolUse hook, the policy, the approvals that only a person at a terminal can grant, and the budgets all apply exactly as before. Do not attach images that contain secrets you would not paste into a prompt: stripping removes metadata, not what the picture shows.

## Exit codes

| Code | When |
| --- | --- |
| 0 | done |
| 1 | session not found or archived, the stored copy cannot be written, claude not installed |
| 2 | a file is refused (format, size, dimensions, not a regular file, device or UNC path, missing), too many images, an unknown or ambiguous attachment id, `--image` without a path, the routed model lists no image input, `detach` without `--yes` outside a terminal |

With `--json` a failed command prints exactly one JSON document: the error envelope.

## Unverified

- The stream-json input shape for images, and whether Claude Code accepts it in `-p` mode at all.
- Provider limits for image size, count and dimensions (the numbers above are this tool's guesses).
- Whether a model sees or understands an image. The static catalog only lists a documented capability; it is not a test.
- Whether images sent with a turn that failed were already seen by the provider; that is why each attempt uses a fresh provider session.
