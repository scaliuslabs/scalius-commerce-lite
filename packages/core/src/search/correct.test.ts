import { describe, expect, it } from "vitest";

import { correctSearchQuery, transliterateBangla } from "./correct";

const CATALOG = [
  "Copper Tea Kettle",
  "Trail Belt Bag",
  "Canvas Tote Bag",
  "Oxford Cotton Shirt",
  "Classic Running Shoes",
  "Leather Shoes",
  "Pebble Camera Strap",
  "সুতি পাঞ্জাবি",
  "Bags",
];

describe("search query correction", () => {
  it.each([
    ["kettel", "kettle"],
    ["ketle", "kettle"],
    ["Kettel", "kettle"],
    ["tote bagg", "tote bag"],
    ["shirts oxfrod", "shirt oxford"],
  ])("corrects the typo %s to catalog words", (query, expected) => {
    expect(correctSearchQuery(query, CATALOG)).toBe(expected);
  });

  it.each([
    ["ব্যাগ", "bag"],
    ["কেতলি", "kettle"],
    ["চায়ের কেতলি", "kettle"],
    ["শার্ট", "shirt"],
    ["ক্যামেরা", "camera"],
    ["জুতা", "shoes"],
  ])("maps the Bangla query %s to the English catalog word", (query, expected) => {
    expect(correctSearchQuery(query, CATALOG)).toBe(expected);
  });

  it("matches Bangla catalog names typed in another Unicode form or in Latin letters", () => {
    const decomposedYa = "য়";
    expect(correctSearchQuery(`পাঞ্জাবী`, CATALOG)).toBe("পাঞ্জাবি");
    expect(correctSearchQuery("panjabi", CATALOG)).toBe("পাঞ্জাবি");
    expect(transliterateBangla(`চা${decomposedYa}ের`)).toBe(transliterateBangla("চায়ের"));
  });

  it("leaves queries alone when every term already matches or nothing is close", () => {
    expect(correctSearchQuery("kettle", CATALOG)).toBeNull();
    expect(correctSearchQuery("ket", CATALOG)).toBeNull();
    expect(correctSearchQuery("zzzzqqq", CATALOG)).toBeNull();
    expect(correctSearchQuery("", CATALOG)).toBeNull();
    expect(correctSearchQuery("red", ["Bed Sheet"])).toBeNull();
  });
});
