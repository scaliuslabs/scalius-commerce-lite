// The places a buyer may pick: the rules, and the committed dataset passing them.
import { describe, expect, it } from "vitest";
import { deactivatePlaceDatasetProblems, isJunkPlaceName, placeDatasetProblems, placeNameIdentity } from "./place-rules";
import type { PlaceEntry } from "./places";
import dataset from "../places/places.json";

const places = dataset as PlaceEntry[];

const city = (key: string, name: string, active = true): PlaceEntry => ({ key, level: 1, parent: null, name, externalIds: { pathao: key }, active });
const thana = (key: string, parent: string, name: string, active = true): PlaceEntry => ({ key, level: 2, parent, name, externalIds: { pathao: key }, active });

describe("place names", () => {
  it("rejects a letter typed over and over, placeholders and empty names", () => {
    for (const name of ["Dhakaaaaaaaa", "Mirpurrrr", "test", " Unknown ", "N/A", "dummy", ""]) {
      expect(isJunkPlaceName(name), name).toBe(true);
    }
  });

  it("keeps real names, misspelt or with a doubled or tripled letter", () => {
    for (const name of ["Dhaka", "Sadulllahpur", "Cox's Bazar", "Nahid Nagar", "Azimpur (Lalbag)", "চট্টগ্রাম বন্দর কলেজ", "Tolla railline(তল্লা রেললাইন)"]) {
      expect(isJunkPlaceName(name), name).toBe(false);
    }
  });

  it("reads two names as one when they differ only by case, accents or spacing", () => {
    expect(placeNameIdentity("Mirpur  10")).toBe(placeNameIdentity("mirpur 10"));
    expect(placeNameIdentity("Bogurá")).toBe(placeNameIdentity("Bogura"));
    expect(placeNameIdentity("Bogra")).not.toBe(placeNameIdentity("Bogura"));
  });
});

describe("place dataset rules", () => {
  it("flags junk names, a second sibling with the same name and a city with nothing below", () => {
    const entries = [
      city("c1", "Dhaka"), thana("z1", "c1", "Mirpur"), thana("z2", "c1", "MIRPUR"), thana("z3", "c1", "Gulshan"),
      city("c2", "Dhakaaaaaaaa"),
      city("c3", "Nahid"),
      city("c4", "Bogura"), thana("z4", "c4", "Sherpur", false),
      city("c5", "Old test", false),
    ];
    expect(placeDatasetProblems(entries)).toEqual([
      { key: "c2", name: "Dhakaaaaaaaa", reason: "junk_name" },
      { key: "z2", name: "MIRPUR", reason: "duplicate_name" },
      { key: "c3", name: "Nahid", reason: "nothing_below" },
      { key: "c4", name: "Bogura", reason: "nothing_below" },
    ]);
  });

  it("switches problem places off, ids kept, until none is left", () => {
    const entries = [city("c1", "Dhaka"), thana("z1", "c1", "Mirpur"), city("c2", "Rangpur"), thana("z2", "c2", "testtttt")];
    const cleaned = deactivatePlaceDatasetProblems(entries);
    // The junk thana goes off, and with it the city that had nothing else.
    expect(cleaned.filter((entry) => !entry.active).map((entry) => entry.key)).toEqual(["c2", "z2"]);
    expect(cleaned.find((entry) => entry.key === "c2")?.externalIds).toEqual({ pathao: "c2" });
    expect(placeDatasetProblems(cleaned)).toEqual([]);
  });
});

describe("the Bangladesh dataset", () => {
  it("offers buyers only real places", () => {
    expect(placeDatasetProblems(places)).toEqual([]);
  });

  it("keeps Pathao's test cities switched off with their courier ids, and every real city on", () => {
    const cities = places.filter((place) => place.level === 1);
    expect(cities.filter((place) => !place.active).map((place) => [place.name, place.externalIds.pathao])).toEqual([
      ["Dhakaaaaaaaa", "146"],
      ["Nahid", "147"],
    ]);
    expect(cities.filter((place) => place.active)).toHaveLength(64);
    expect(cities.find((place) => place.name === "Dhaka")).toMatchObject({ active: true, externalIds: { pathao: "1" } });
  });
});
