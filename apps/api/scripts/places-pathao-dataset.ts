/**
 * Refreshes the Bangladesh place dataset (plugins/bangladesh/places, the Bangladesh pack's) from Pathao's
 * location API: a courier refresh becomes a reviewed diff of places.json.
 *
 *   pnpm places:pathao-dataset --credentials <file.json> [--dataset plugins/bangladesh/places]
 *   pnpm places:pathao-dataset --recheck [--dataset plugins/bangladesh/places]
 *
 * Both apply the pack's place rules (plugins/bangladesh/src/place-rules.ts):
 * a junk name, a duplicate sibling or a city with no thana is kept with its
 * courier ids but switched off. `--recheck` applies them to the committed
 * dataset without calling Pathao (after a rule changes); a refresh refuses to
 * write a dataset that still breaks them.
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

import { buildPathaoPlaceDataset, pathaoLocationClient } from "../../../plugins/bangladesh/src/pathao-places";
import { deactivatePlaceDatasetProblems, placeDatasetProblems } from "../../../plugins/bangladesh/src/place-rules";
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
  const recheck = process.argv.includes("--recheck");
  if (!credentialsPath && !recheck) {
    throw new Error("Pass --credentials <file.json> (Pathao baseUrl, clientId, clientSecret, username, password), or --recheck.");
  }
  const dataset = fromRoot(option("dataset") ?? "plugins/bangladesh/places");
  const manifest = JSON.parse(readFileSync(join(dataset, "manifest.json"), "utf8")) as PlaceDatasetManifest;
  const previous = JSON.parse(readFileSync(join(dataset, "places.json"), "utf8")) as PlaceDatasetEntry[];
  const legacyIds = new Map(previous.flatMap((place) => (place.legacyId ? [[place.key, place.legacyId] as const] : [])));

  let places: PlaceDatasetEntry[];
  if (recheck) {
    places = deactivatePlaceDatasetProblems(previous);
  } else {
    const account = JSON.parse(readFileSync(fromRoot(credentialsPath!), "utf8"));
    const client = pathaoLocationClient(account, async (url, init) => {
      const response = await fetch(url, init);
      return { ok: response.ok, status: response.status, json: <T>() => response.json() as Promise<T> };
    });
    places = await buildPathaoPlaceDataset(client, { legacyIds }) as PlaceDatasetEntry[];
  }
  const problems = placeDatasetProblems(places);
  if (problems.length > 0) {
    throw new Error(`The dataset still offers places that break the place rules: ${problems.slice(0, 10).map((problem) => `${problem.key} "${problem.name}" (${problem.reason})`).join(", ")}`);
  }
  const switchedOff = previous
    .filter((place) => place.active && places.find((next) => next.key === place.key)?.active === false)
    .map((place) => `${place.key} ${place.name}`);
  const text = serializePlaceDataset(places);
  const { counts, inactive } = placeDatasetCounts(places);
  const next: PlaceDatasetManifest = {
    ...manifest,
    // A recheck changes no data from Pathao: the export date stays.
    exportedAt: recheck ? manifest.exportedAt : new Date().toISOString().slice(0, 10),
    counts,
    inactive,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  if (text === readFileSync(join(dataset, "places.json"), "utf8")) {
    console.log(JSON.stringify({ places: places.length, unchanged: true }));
    return;
  }
  writeFileSync(join(dataset, "places.json"), text);
  writeFileSync(join(dataset, "manifest.json"), `${JSON.stringify(next, null, 2)}\n`);
  const before = new Set(previous.map((place) => place.key));
  const after = new Set(places.map((place) => place.key));
  console.log(JSON.stringify({
    places: places.length,
    added: [...after].filter((key) => !before.has(key)).length,
    removed: [...before].filter((key) => !after.has(key)).length,
    switchedOff,
    sha256: next.sha256,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
