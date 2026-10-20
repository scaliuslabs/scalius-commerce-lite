// Place seeding through the place import port: chunked in dataset order,
// resumable from KV, idempotent once current, never deleting on uninstall.
// `ctx.api.call` is answered by a fake import that remembers the keys it got.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import pack, { manifest } from "./index";
import { PLACES_CHUNK, PLACES_COUNTRY, PLACES_SOURCE, PLACES_TOTAL, PLACES_VERSION, seedPlaces, type PlaceEntry } from "./places";
import dataset from "../places/manifest.json";

interface ImportCall { body: { country: string; source: string; version: string; places: PlaceEntry[]; finish?: boolean }; idempotencyKey?: string }

function fakeStore(options: { failAt?: number; status?: number } = {}) {
  const calls: ImportCall[] = [];
  const keys = new Set<string>();
  const instance = createPluginTestHarness(pack, {
    api: (operationId, input) => {
      expect(operationId).toBe("dashboard.delivery_locations.import");
      const call = input as ImportCall;
      calls.push(call);
      if (options.failAt === calls.length) {
        return { ok: false, status: options.status ?? 503, data: null, error: { code: "service_unavailable", message: "busy" } };
      }
      let created = 0;
      for (const place of call.body.places) {
        if (!keys.has(place.key)) created += 1;
        keys.add(place.key);
      }
      return { ok: true, status: 200, data: { created, updated: call.body.places.length - created, unchanged: 0, skipped: 0, deactivated: 0, conflicts: [], conflictCount: 0 }, error: null };
    },
  });
  return { instance, calls, keys };
}

const tiny: PlaceEntry[] = [
  { key: "t:city:1", level: 1, parent: null, name: "Dhaka", externalIds: { pathao: "1" }, active: true },
  { key: "t:zone:1", level: 2, parent: "t:city:1", name: "Mirpur", externalIds: { pathao: "11" }, active: true },
];

describe("Bangladesh places", () => {
  it("ships the Pathao dataset its manifest describes", () => {
    expect(PLACES_COUNTRY).toBe("BD");
    expect(PLACES_SOURCE).toBe("bd");
    expect(PLACES_VERSION).toMatch(/^[0-9a-f]{64}$/);
    expect(PLACES_TOTAL).toBe(11_550);
    expect(dataset.counts).toEqual({ 1: 66, 2: 1258, 3: 10226 });
  });

  it("loads every place when the places feature is turned on, in chunks of 500, parents first, finishing on the last", async () => {
    const store = fakeStore();
    const activated = await store.instance.feature("enable", "places");
    expect(activated.ok).toBe(true);
    expect(store.keys.size).toBe(PLACES_TOTAL);
    expect(store.calls).toHaveLength(Math.ceil(PLACES_TOTAL / PLACES_CHUNK));
    expect(store.calls.every((call) => call.body.places.length <= PLACES_CHUNK)).toBe(true);
    expect(store.calls.map((call) => call.body.finish)).toEqual(store.calls.map((_, index) => index === store.calls.length - 1));
    expect(store.calls.every((call) => call.idempotencyKey === undefined)).toBe(true);
    const seen = new Set<string>();
    for (const call of store.calls) {
      expect(call.body).toMatchObject({ country: "BD", source: "bd", version: PLACES_VERSION });
      for (const place of call.body.places) {
        if (place.parent) expect(seen.has(place.parent)).toBe(true);
        seen.add(place.key);
      }
    }
    expect(store.instance.kv.get("places")).toMatchObject({ version: PLACES_VERSION, done: true, next: PLACES_TOTAL, created: PLACES_TOTAL });
  });

  it("does nothing once the store has this version (turning it on, the hourly job and the button alike)", async () => {
    const store = fakeStore();
    await store.instance.feature("enable", "places");
    const sent = store.calls.length;
    await store.instance.feature("enable", "places");
    await store.instance.cron("places_sync");
    expect(store.calls).toHaveLength(sent);
  });

  it("stops at a failed chunk, says why on the places page, and resumes there", async () => {
    const store = fakeStore({ failAt: 3 });
    const activated = await store.instance.feature("enable", "places");
    expect(activated.ok).toBe(false);
    expect(store.instance.kv.get("places")).toMatchObject({ done: false, next: 2 * PLACES_CHUNK, error: expect.stringContaining("within the hour") });
    const page = await store.instance.route("admin", "places");
    expect(JSON.stringify(page.value)).toContain("within the hour");
    await store.instance.cron("places_sync");
    expect(store.calls[3]!.body.places[0]).toEqual(store.calls[2]!.body.places[0]);
    expect(store.instance.kv.get("places")).toMatchObject({ done: true, error: null });
  });

  it("asks for approval again when the grant no longer covers the import", async () => {
    const store = fakeStore({ failAt: 1, status: 403 });
    await store.instance.feature("enable", "places");
    expect(store.instance.kv.get("places")).toMatchObject({ error: expect.stringContaining("Approve its access again") });
  });

  /** A module whose activation and cron seed `tiny` (or the version KV names) through the real seeder. */
  function tinyPack(options: { budgetMs: number; now?: () => number; places?: PlaceEntry[] }) {
    const calls: ImportCall[] = [];
    const run = async (ctx: Parameters<typeof seedPlaces>[0]) => {
      await seedPlaces(ctx, { budgetMs: options.budgetMs, places: async () => options.places ?? tiny, version: (await ctx.kv.get<string>("test-version")) ?? "v1", ...(options.now ? { now: options.now } : {}) });
    };
    const instance = createPluginTestHarness({ default: { ...pack, lifecycle: { enable: run }, cron: { ...pack.cron, places_sync: run } } }, {
      api: (_id, input) => {
        calls.push(input as ImportCall);
        return { ok: true, status: 200, data: { created: 1, updated: 0, unchanged: 0, skipped: 0, deactivated: 0, conflicts: [], conflictCount: 0 }, error: null };
      },
    });
    return { instance, calls };
  }

  it("leaves the rest to the next run when the time budget is spent", async () => {
    let clock = 0;
    const cities = Array.from({ length: PLACES_CHUNK + 1 }, (_, index): PlaceEntry => ({ key: `t:city:${index}`, level: 1, parent: null, name: `City ${index}`, externalIds: {}, active: true }));
    const { instance, calls } = tinyPack({ budgetMs: 1, now: () => (clock += 1), places: cities });
    await instance.feature("enable", "places");
    expect(calls).toHaveLength(1);
    expect(instance.kv.get("places")).toMatchObject({ version: "v1", next: PLACES_CHUNK, done: false });
    await instance.cron("places_sync");
    expect(calls.map((call) => [call.body.places.length, call.body.finish])).toEqual([[PLACES_CHUNK, false], [1, true]]);
  });

  it("loads a newer dataset version from the start, as after an app update", async () => {
    const { instance, calls } = tinyPack({ budgetMs: 60_000 });
    await instance.cron("places_sync");
    await instance.cron("places_sync");
    instance.kv.set("test-version", "v2");
    await instance.cron("places_sync");
    expect(calls.map((call) => [call.body.version, call.body.finish])).toEqual([["v1", true], ["v2", true]]);
  });

  it("never deletes places when the pack is removed, with or without its data", async () => {
    for (const keepData of [true, false]) {
      const store = fakeStore();
      await store.instance.feature("enable", "places");
      const sent = store.calls.length;
      expect((await store.instance.lifecycle("uninstall", keepData)).ok).toBe(true);
      expect(store.calls).toHaveLength(sent);
    }
    expect(manifest.scopes).toEqual([]);
    expect(manifest.features.find((entry) => entry.id === "places")?.scopes).toEqual(["write_places"]);
  });
});

describe("the bundled place directory", () => {
  // Bundled as text, the 2.3 MB dataset costs a Worker isolate almost nothing
  // at start-up; as a JSON import it is one array literal that workerd compiles
  // at every API isolate start (about 120 ms, docs/PERFORMANCE-RELEASE.md).
  it("reaches the bundle as a string, parsed only when a seed runs", async () => {
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: [new URL("./places.ts", import.meta.url).pathname],
      bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent",
      external: ["@scalius/*"],
    });
    const code = result.outputFiles[0]!.text;
    expect(code).toContain('{"key":"pathao:');
    expect(code).not.toMatch(/\bkey: "pathao:/);
  }, 30_000);
});
