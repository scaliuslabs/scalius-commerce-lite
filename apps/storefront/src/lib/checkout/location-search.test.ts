import { describe, expect, it } from "vitest";
import { placeMatches } from "./location-search";

const places = ["Love Road, Mirpur-2", "Mirpur-10", "Dhanmondi", "Mohammadpur", "Gulshan", "Uttara", "Tejgaon", "Banani"];
const find = (query: string) => places.filter((place) => placeMatches(place, query));

describe("thana search", () => {
  it("ignores spaces, hyphens, case and Bengali digits", () => {
    expect(find("mirpur 2")).toEqual(["Love Road, Mirpur-2"]);
    expect(find("MIRPUR-১০")).toEqual(["Mirpur-10"]);
    expect(find("love road")).toEqual(["Love Road, Mirpur-2"]);
  });

  it("finds English names from Bangla typing", () => {
    expect(find("মিরপুর")).toEqual(["Love Road, Mirpur-2", "Mirpur-10"]);
    expect(find("ধানমন্ডি")).toEqual(["Dhanmondi"]);
    expect(find("মোহাম্মদপুর")).toEqual(["Mohammadpur"]);
    expect(find("গুলশান")).toEqual(["Gulshan"]);
    expect(find("উত্তরা")).toEqual(["Uttara"]);
    expect(find("তেজগাঁও")).toEqual(["Tejgaon"]);
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
