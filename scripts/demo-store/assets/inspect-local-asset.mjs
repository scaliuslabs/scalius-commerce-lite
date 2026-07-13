import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { open, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

import {
  IMAGE_MIME_LIMIT_BYTES,
  VIDEO_MIME_LIMIT_BYTES,
} from "./profiles.mjs";

const requireFromStorefront = createRequire(
  new URL("../../../apps/storefront/package.json", import.meta.url),
);
const sharp = requireFromStorefront("sharp");
const execFileAsync = promisify(execFile);

const FORMAT_TO_MIME = Object.freeze({
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
});

async function readPrefix(filePath) {
  const handle = await open(filePath, "r");
  try {
    const prefix = Buffer.alloc(16);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return prefix.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function detectedVideoMime(prefix) {
  if (prefix.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  return null;
}

async function inspectVideo(filePath, mime) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "json", filePath,
    ]));
  } catch {
    throw new Error("ffprobe is required to verify video dimensions");
  }
  const stream = JSON.parse(stdout).streams?.[0];
  if (!Number.isInteger(stream?.width) || !Number.isInteger(stream?.height)) {
    throw new Error("Video has no readable visual dimensions");
  }
  return { kind: "video", mime, width: stream.width, height: stream.height };
}

export async function inspectLocalAsset(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("Asset source must be a regular file");
  if (info.size <= 0) throw new Error("Asset source cannot be empty");

  const prefix = await readPrefix(filePath);
  const videoMime = detectedVideoMime(prefix);
  const kind = videoMime ? "video" : "image";
  const limit = kind === "video" ? VIDEO_MIME_LIMIT_BYTES : IMAGE_MIME_LIMIT_BYTES;
  if (info.size > limit) throw new Error(`Source exceeds ${limit} bytes`);

  const bytes = await readFile(filePath);
  let media;
  if (videoMime) {
    media = await inspectVideo(filePath, videoMime);
  } else {
    const metadata = await sharp(bytes, { animated: false, failOn: "error" }).metadata();
    const mime = FORMAT_TO_MIME[metadata.format];
    if (!mime || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)) {
      throw new Error("Asset source is not a supported image or video");
    }
    media = { kind: "image", mime, width: metadata.width, height: metadata.height };
  }

  return {
    ...media,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
