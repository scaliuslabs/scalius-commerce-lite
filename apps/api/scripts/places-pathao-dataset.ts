/**
 * Refreshes the Bangladesh place dataset (plugins/bangladesh/places, the Bangladesh pack's) from Pathao's
 * location API: a courier refresh becomes a reviewed diff of places.json.
 *
 *   pnpm places:pathao-dataset --credentials <file.json> [--dataset plugins/bangladesh/places]
 *
 * The credentials file holds { baseUrl, clientId, clientSecret, username,
 * password } of a Pathao merchant account; keep it outside the repository.
 * Places keep their key and legacy id; the manifest gets the new counts, date
 * and SHA-256. Review the diff, then commit it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPathaoPlaceDataset } from "@scalius/core/modules/delivery";
import {
  placeDatasetCounts,
  serializePlaceDataset,
  type PlaceDatasetEntry,
  type PlaceDatasetManifest,
} from "@scalius/shared/places";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const fromRoot = (path: string) => (isAbsolute(path) ? path : resolve(root, path));

async function main() {
  const credentialsPath = option("credentials");
  if (!credentialsPath) throw new Error("Pass --credentials <file.json> (Pathao baseUrl, clientId, clientSecret, username, password).");
  const dataset = fromRoot(option("dataset") ?? "plugins/bangladesh/places");
  const manifest = JSON.parse(readFileSync(join(dataset, "manifest.json"), "utf8")) as PlaceDatasetManifest;
  const previous = JSON.parse(readFileSync(join(dataset, "places.json"), "utf8")) as PlaceDatasetEntry[];
  const legacyIds = new Map(previous.flatMap((place) => (place.legacyId ? [[place.key, place.legacyId] as const] : [])));

  const places = await buildPathaoPlaceDataset(JSON.parse(readFileSync(fromRoot(credentialsPath), "utf8")), { legacyIds });
  const text = serializePlaceDataset(places);
  const { counts, inactive } = placeDatasetCounts(places);
  const next: PlaceDatasetManifest = {
    ...manifest,
    exportedAt: new Date().toISOString().slice(0, 10),
    counts,
    inactive,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  writeFileSync(join(dataset, "places.json"), text);
  writeFileSync(join(dataset, "manifest.json"), `${JSON.stringify(next, null, 2)}\n`);
  const before = new Set(previous.map((place) => place.key));
  const after = new Set(places.map((place) => place.key));
  console.log(JSON.stringify({
    places: places.length,
    added: [...after].filter((key) => !before.has(key)).length,
    removed: [...before].filter((key) => !after.has(key)).length,
    sha256: next.sha256,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
