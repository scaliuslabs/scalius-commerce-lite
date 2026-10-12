// The checks on a release's storefront files (storefront-components.ts),
// run by the upload and the registry download before anything is stored:
// every sealed file present and matching its digest, exactly the files the
// manifest's components need, each within its budget, public files real
// fonts and images (assets.ts). The storefront serves only files that passed.

import { checkStorefrontPublicFile } from "./assets";
import { pluginHasStorefrontModule, type PluginManifest } from "./manifest";
import {
  STOREFRONT_COMPONENT_LIMITS,
  STOREFRONT_MODULE_FILE,
  STOREFRONT_STYLESHEET_FILE,
  sealedStorefrontDigests,
  storefrontFileContentType,
  storefrontIslandFile,
} from "./storefront-protocol";

const SHA256_HEX = /^[0-9a-f]{64}$/;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The release's storefront files, read with `read` and checked against the
 * digests sealed into its bundle and against its manifest. Throws the first
 * problem as an Error whose message names the file.
 */
export async function verifyStorefrontFiles(
  manifest: PluginManifest,
  code: string,
  read: (path: string) => Promise<Uint8Array | null>,
): Promise<Map<string, Uint8Array>> {
  const sealed = sealedStorefrontDigests(code);
  const paths = Object.keys(sealed);
  const storefront = manifest.storefront;
  const expect = (present: boolean, path: string, what: string) => {
    if (present !== paths.includes(path)) {
      throw new Error(present ? `The release declares ${what} but has no storefront/${path}; pack it with pnpm plugin pack.` : `storefront/${path} is not declared in the manifest.`);
    }
  };
  expect(pluginHasStorefrontModule(storefront), STOREFRONT_MODULE_FILE, "storefront components");
  expect(storefront.stylesheet, STOREFRONT_STYLESHEET_FILE, "a stylesheet");
  const islands = new Set(storefront.islands.map((island) => storefrontIslandFile(island.name)));
  for (const path of paths) {
    if (path.startsWith("islands/") && !islands.has(path)) throw new Error(`storefront/${path} is not a declared island.`);
  }
  for (const path of islands) if (!paths.includes(path)) throw new Error(`The release has no storefront/${path}.`);

  const limits = STOREFRONT_COMPONENT_LIMITS;
  const files = new Map<string, Uint8Array>();
  let islandBytes = 0;
  let publicBytes = 0;
  let publicFiles = 0;
  for (const path of paths) {
    if (!storefrontFileContentType(path) || !SHA256_HEX.test(sealed[path]!)) throw new Error(`storefront/${path} is not a storefront file.`);
    const bytes = await read(path);
    if (!bytes || await sha256Hex(bytes) !== sealed[path]) throw new Error(`storefront/${path} is missing or does not match the bundle.`);
    const size = bytes.byteLength;
    if (path === STOREFRONT_MODULE_FILE && size > limits.moduleBytes) throw new Error(`storefront/${path} is over ${limits.moduleBytes} bytes.`);
    if (path === STOREFRONT_STYLESHEET_FILE && size > limits.stylesheetBytes) throw new Error(`storefront/${path} is over ${limits.stylesheetBytes} bytes.`);
    if (path.startsWith("islands/")) {
      if (size > limits.islandBytes) throw new Error(`storefront/${path} is over ${limits.islandBytes} bytes.`);
      islandBytes += size;
    }
    if (path.startsWith("public/")) {
      const problem = checkStorefrontPublicFile(path.slice("public/".length), bytes);
      if (problem) throw new Error(problem);
      publicBytes += size;
      publicFiles += 1;
    }
    files.set(path, bytes);
  }
  if (islandBytes > limits.islandsBytes) throw new Error(`The islands are over ${limits.islandsBytes} bytes together.`);
  if (publicBytes > limits.publicBytes || publicFiles > limits.publicFiles) {
    throw new Error(`The public files are over ${limits.publicFiles} files or ${limits.publicBytes} bytes.`);
  }
  return files;
}
