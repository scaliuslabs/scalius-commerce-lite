import { describe, expect, it } from "vitest";
import { rankPlaces } from "./location-search";

const places = ["Love Road, Mirpur-2", "Mirpur-10", "Dhanmondi", "Mohammadpur", "Gulshan", "Uttara", "Tejgaon", "Banani"];
const find = (query: string, list = places) =>
  rankPlaces(list.map((name) => ({ name })), query).map((place) => place.name);

describe("place search", () => {
  it("ignores spaces, hyphens, case, accents and Bengali digits", () => {
    expect(find("mirpur 2")).toEqual(["Love Road, Mirpur-2"]);
    expect(find("MIRPUR-১০")).toEqual(["Mirpur-10"]);
    expect(find("love road")).toEqual(["Love Road, Mirpur-2"]);
    expect(find("cox", ["Coxʼs Bazar", "Cóx Hill"])).toEqual(["Coxʼs Bazar", "Cóx Hill"]);
  });

  it("finds English names from Bangla typing", () => {
    expect(find("মিরপুর")).toEqual(["Mirpur-10", "Love Road, Mirpur-2"]);
    expect(find("ধানমন্ডি")).toEqual(["Dhanmondi"]);
    expect(find("মোহাম্মদপুর")).toEqual(["Mohammadpur"]);
    expect(find("গুলশান")).toEqual(["Gulshan"]);
    expect(find("উত্তরা")).toEqual(["Uttara"]);
    expect(find("তেজগাঁও")).toEqual(["Tejgaon"]);
    expect(find("চট্টগ্রাম", ["Chattogram", "Sylhet"])).toEqual(["Chattogram"]);
    // Bangla জ and ভ are written z and v in English place names.
    expect(find("জিন্দা", ["Amberkhana", "Zindabazar"])).toEqual(["Zindabazar"]);
    expect(find("ভাটারা", ["Badda", "Vatara"])).toEqual(["Vatara"]);
  });

  it("finds Bangla names from English typing", () => {
    expect(find("gul", ["গুলশান", "বনানী"])).toEqual(["গুলশান"]);
  });

  it("puts names that start with the text first, then words that start with it", () => {
    const thanas = ["Demra", "Kamrangirchar", "Mirpur", "Mirpur-10", "Shah Ali", "Chawkbazar", "Kafrul", "Khilgaon"];
    expect(find("mir", thanas)).toEqual(["Mirpur", "Mirpur-10"]);
    expect(find("k", thanas)).toEqual(["Kamrangirchar", "Kafrul", "Khilgaon", "Chawkbazar"]);
    expect(find("ali", thanas)).toEqual(["Shah Ali"]);
  });

  it("tolerates common English spelling variants", () => {
    expect(find("dhanmandi")).toEqual(["Dhanmondi"]);
    expect(find("mohammedpur")).toEqual(["Mohammadpur"]);
  });

  it("does not over-match short input", () => {
    expect(find("zz")).toEqual([]);
    expect(find("")).toEqual(places);
  });
});
