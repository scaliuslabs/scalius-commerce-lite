/**
 * Imports a place dataset (plugins/<pack>/places/) into the local D1 state
 * through the same service the dashboard, agents and plugins call
 * (`importPlaces`, delivery/places-import.ts). Local only: it opens the
 * Wrangler state's D1 file with Miniflare and reads no env file.
 *
 *   pnpm places:import [--dataset plugins/bangladesh/places] [--state .wrangler/state]
 *
 * The dataset's manifest names the country, the dataset id (the source) and
 * the version (the SHA-256 of places.json, checked here). Places go in calls
 * of at most 500, parents first; the last call finishes the version. Running
 * it again changes nothing.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { getDb } from "@scalius/database/client";
import { importPlaces } from "@scalius/core/modules/delivery";
import { PLACE_IMPORT_MAX_ENTRIES, sortPlaceDataset, type PlaceDatasetEntry, type PlaceDatasetManifest } from "@scalius/shared/places";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const fromRoot = (path: string) => (isAbsolute(path) ? path : resolve(root, path));

/** The local D1 database id: the one `wrangler dev` and the local migrations use. */
function localDatabaseId(): string {
  const config = readFileSync(join(root, "apps/api/wrangler.jsonc"), "utf8").replace(/(?<!https?:)\/\/[^\n]*/g, "");
  const id = (JSON.parse(config) as { d1_databases?: Array<{ database_id?: string }> }).d1_databases?.[0]?.database_id;
  if (!id) throw new Error("apps/api/wrangler.jsonc has no d1_databases[0].database_id.");
  return id;
}

export function readPlaceDataset(directory: string): { manifest: PlaceDatasetManifest; places: PlaceDatasetEntry[] } {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as PlaceDatasetManifest;
  const text = readFileSync(join(directory, "places.json"), "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  if (sha256 !== manifest.sha256) {
    throw new Error(`places.json does not match its manifest (sha256 ${sha256}, manifest ${manifest.sha256}).`);
  }
  return { manifest, places: sortPlaceDataset(JSON.parse(text) as PlaceDatasetEntry[]) };
}

async function main() {
  const dataset = fromRoot(option("dataset") ?? "plugins/bangladesh/places");
  const state = fromRoot(option("state") ?? process.env.SCALIUS_WRANGLER_STATE ?? ".wrangler/state");
  const { manifest, places } = readPlaceDataset(dataset);
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default {}",
    // As `wrangler d1 execute --local --persist-to <state>` opens it.
    resourcePersistencePath: join(state, "v3"),
    d1Databases: { DB: localDatabaseId() },
  }) as never);
  try {
    const db = getDb({ DB: await miniflare.getD1Database("DB") } as never);
    const total = { created: 0, updated: 0, unchanged: 0, skipped: 0, deactivated: 0, conflictCount: 0 };
    const conflicts: unknown[] = [];
    for (let offset = 0; offset < places.length; offset += PLACE_IMPORT_MAX_ENTRIES) {
      const result = await importPlaces(db, {
        country: manifest.country,
        source: manifest.id,
        version: manifest.sha256,
        places: places.slice(offset, offset + PLACE_IMPORT_MAX_ENTRIES),
        finish: offset + PLACE_IMPORT_MAX_ENTRIES >= places.length,
      });
      for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += result[key];
      conflicts.push(...result.conflicts);
    }
    console.log(JSON.stringify({ dataset: manifest.id, country: manifest.country, version: manifest.sha256, places: places.length, ...total, conflicts: conflicts.slice(0, 20) }));
  } finally {
    await miniflare.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
