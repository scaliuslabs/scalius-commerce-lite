/**
 * Writing a bundle to disk, and the guard that decides whether it may be
 * written at all.
 *
 * Re-running an export into the same directory is the normal case, so an output
 * directory that holds only this exporter's own entries is accepted and
 * replaced. Any other entry means the operator pointed `--export` at a
 * directory that is something else, and the export refuses rather than
 * clobbering it.
 *
 * Write order matters. `bundle.json` is the manifest that declares the bundle
 * complete, so it is written last: an export interrupted partway through leaves
 * a directory without a manifest, never a manifest that overstates what is
 * beside it.
 */

import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveObjectPath } from "./media.mjs";
import {
  BUNDLE_ENTRIES,
  BUNDLE_MANIFEST_FILENAME,
  MEDIA_DIRECTORY_NAME,
  MEDIA_MANIFEST_FILENAME,
  SEED_SQL_FILENAME,
} from "./tables.mjs";

/**
 * Proves the output directory is either absent, empty, or a previous bundle
 * from this exporter. It deliberately creates nothing: an export that is going
 * to be refused should leave no trace at all, and the directory is created by
 * `writeBundle` once the whole bundle is known to be complete.
 */
export async function assertBundleDirectoryUsable(exportDirectory, {
  readdirImpl = readdir,
} = {}) {
  const resolved = path.resolve(exportDirectory);
  let entries;
  try {
    entries = await readdirImpl(resolved, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    throw error;
  }
  const foreign = entries
    .filter((entry) => !BUNDLE_ENTRIES.includes(entry.name))
    .map((entry) => entry.name);
  if (foreign.length > 0) {
    throw new Error(
      `${resolved} already holds ${foreign.sort().join(", ")}, which this exporter did not write. `
      + `Point --export at an empty directory or at a previous seed bundle (${BUNDLE_ENTRIES.join(", ")}); `
      + "the exporter never overwrites files it does not own.",
    );
  }
  const mediaEntry = entries.find((entry) => entry.name === MEDIA_DIRECTORY_NAME);
  if (mediaEntry && !mediaEntry.isDirectory()) {
    throw new Error(
      `${path.join(resolved, MEDIA_DIRECTORY_NAME)} exists but is not a directory, so the exporter cannot write the bundle's media objects there.`,
    );
  }
  return resolved;
}

export async function writeBundle(exportDirectory, bundle, {
  mkdirImpl = mkdir,
  rmImpl = rm,
  writeFileImpl = writeFile,
  copyFileImpl = copyFile,
} = {}) {
  const resolved = path.resolve(exportDirectory);
  const mediaDirectory = path.join(resolved, MEDIA_DIRECTORY_NAME);
  await mkdirImpl(resolved, { recursive: true });

  // A stale media tree from an earlier run would otherwise survive alongside a
  // manifest that no longer lists it, so the directory is always rebuilt.
  await rmImpl(mediaDirectory, { recursive: true, force: true });
  await rmImpl(path.join(resolved, BUNDLE_MANIFEST_FILENAME), { force: true });

  await writeFileImpl(path.join(resolved, SEED_SQL_FILENAME), bundle.seedSql, "utf8");

  const writtenObjects = [];
  for (const object of bundle.mediaObjects) {
    const destination = resolveObjectPath(mediaDirectory, object.objectKey);
    await mkdirImpl(path.dirname(destination), { recursive: true });
    await copyFileImpl(object.sourcePath, destination);
    writtenObjects.push(path.relative(resolved, destination));
  }

  await writeFileImpl(path.join(resolved, MEDIA_MANIFEST_FILENAME), bundle.mediaManifestJson, "utf8");
  await writeFileImpl(path.join(resolved, BUNDLE_MANIFEST_FILENAME), bundle.bundleManifestJson, "utf8");

  return {
    directory: resolved,
    files: [SEED_SQL_FILENAME, MEDIA_MANIFEST_FILENAME, BUNDLE_MANIFEST_FILENAME],
    mediaObjects: writtenObjects,
  };
}
