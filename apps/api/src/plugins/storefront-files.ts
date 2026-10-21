// An installed app's storefront files in R2 (packages/plugin-sdk/docs/storefront.md):
// its storefront module, stylesheet, islands and public files, stored by the
// upload or registry install after `verifyStorefrontFiles`, beside an index
// of their digests. The storefront reads them through the public file route
// (immutable, by release) and its isolate loader reads the module. A file is
// served only for the app's current release and only when its bytes still
// match the index. Bundled apps never come here: their files are compiled
// into the storefront.

import type { Database } from "@scalius/database/client";
import { getPluginInstallation } from "@scalius/core/modules/plugins";
import { sha256Hex } from "@scalius/shared/plugins/registry";
import { STOREFRONT_FILE_PATH, storefrontFileContentType } from "@scalius/shared/plugins/storefront-protocol";

/** Where one storefront file of a release is stored (private prefix: never served by the media host). */
export function pluginStorefrontFileKey(pluginId: string, version: string, sha256: string, path: string): string {
  return `private/plugins/${pluginId}/${version}/${sha256}/storefront/${path}`;
}

/** The release's storefront file digests, written last by the install. */
export function pluginStorefrontIndexKey(pluginId: string, version: string, sha256: string): string {
  return `private/plugins/${pluginId}/${version}/${sha256}/storefront.json`;
}

export interface StorefrontFile {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * One storefront file of an installed app's current release, checked against
 * the release's index; null when the app, the release or the file is not
 * there (a bundled app's files are the storefront's own).
 */
export async function readPluginStorefrontFile(
  env: Pick<Env, "BUCKET">,
  db: Database,
  pluginId: string,
  release: string,
  path: string,
): Promise<StorefrontFile | null> {
  const contentType = storefrontFileContentType(path);
  if (!contentType || !STOREFRONT_FILE_PATH.test(path) || !/^[0-9a-f]{64}$/.test(release)) return null;
  const installation = await getPluginInstallation(db, pluginId);
  if (!installation || installation.source === "bundled" || installation.bundleSha256 !== release) return null;
  const indexObject = await env.BUCKET.get(pluginStorefrontIndexKey(pluginId, installation.version, release));
  if (!indexObject || !("text" in indexObject)) return null;
  let digest: unknown;
  try {
    digest = (JSON.parse(await indexObject.text()) as Record<string, unknown>)[path];
  } catch {
    return null;
  }
  if (typeof digest !== "string") return null;
  const object = await env.BUCKET.get(pluginStorefrontFileKey(pluginId, installation.version, release, path));
  if (!object || !("arrayBuffer" in object)) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== digest) return null;
  return { bytes, contentType };
}
