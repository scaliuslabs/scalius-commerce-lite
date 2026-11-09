#!/usr/bin/env node
// Writes the API Worker's copies of large shared data as JSON text, which the
// API ships as Text modules (strings workerd never compiles at isolate start):
//
//   apps/api/src/generated/checkout-language-presets.gen.txt  the built-in checkout copy (packages/shared/src/checkout-language-presets.ts)
//   apps/api/src/generated/address-metadata.gen.txt           the libaddressinput table (packages/shared/src/address-metadata.data.ts)
//   apps/api/src/generated/libphonenumber-max.gen.txt         libphonenumber-js's full `max` metadata
//   apps/api/src/generated/notification-default-copy.gen.txt  the default notification copy (packages/core/src/modules/notifications/notification-default-copy.ts)
//   apps/api/src/generated/permission-metadata-table.gen.txt  the permission table (packages/core/src/auth/rbac/permission-metadata-table.ts)
//
// The sources stay the one source of truth: browsers, the storefront's server,
// the dashboard and tests import them as they are. Only the API build swaps them, through
// the `alias` entries of apps/api/wrangler.jsonc, for the readers in
// apps/api/src/text-data/, which parse these files on first use.
// apps/api/src/text-data/text-data.test.ts proves the parsed copies equal the
// sources; `pnpm regen` runs this script and `pnpm regen:check` fails on a stale copy.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const generated = join(root, "apps/api/src/generated");
const shared = join(root, "packages/shared");

export const WORKER_TEXT_DATA = Object.freeze({
  checkoutLanguagePresets: join(generated, "checkout-language-presets.gen.txt"),
  addressMetadata: join(generated, "address-metadata.gen.txt"),
  libphonenumberMax: join(generated, "libphonenumber-max.gen.txt"),
  notificationDefaultCopy: join(generated, "notification-default-copy.gen.txt"),
  permissionMetadataTable: join(generated, "permission-metadata-table.gen.txt"),
});

/** A TypeScript module of the repository, bundled with its imports and evaluated. */
async function importSource(path) {
  const esbuild = await import(pathToFileURL(createRequire(join(root, "package.json")).resolve("esbuild")).href);
  const result = await esbuild.build({
    entryPoints: [join(root, path)],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

/** The text of every file, by path. */
export async function renderWorkerTextData() {
  const presets = await importSource("packages/shared/src/checkout-language-presets.ts");
  const address = await importSource("packages/shared/src/address-metadata.data.ts");
  const notifications = await importSource("packages/core/src/modules/notifications/notification-default-copy.ts");
  const permissions = await importSource("packages/core/src/auth/rbac/permission-metadata-table.ts");
  const metadata = createRequire(join(shared, "package.json"))("libphonenumber-js/metadata.max.json");
  return new Map([
    [WORKER_TEXT_DATA.checkoutLanguagePresets, `${JSON.stringify({ en: presets.ENGLISH_CHECKOUT_LANGUAGE_DATA, bn: presets.BANGLA_CHECKOUT_LANGUAGE_DATA })}\n`],
    [WORKER_TEXT_DATA.addressMetadata, `${JSON.stringify({ source: address.ADDRESS_METADATA_SOURCE, defaults: address.ADDRESS_METADATA_DEFAULTS, metadata: address.ADDRESS_METADATA })}\n`],
    [WORKER_TEXT_DATA.libphonenumberMax, `${JSON.stringify(metadata)}\n`],
    [WORKER_TEXT_DATA.notificationDefaultCopy, `${JSON.stringify(notifications.NOTIFICATION_DEFAULT_COPY)}\n`],
    [WORKER_TEXT_DATA.permissionMetadataTable, `${JSON.stringify(permissions.PERMISSION_METADATA)}\n`],
  ]);
}

async function main() {
  for (const [path, text] of await renderWorkerTextData()) {
    let current = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      // Missing: write it.
    }
    if (current === text) continue;
    writeFileSync(path, text);
    console.log(`Updated ${relative(root, path)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
