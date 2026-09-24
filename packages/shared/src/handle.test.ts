import { describe, expect, it } from "vitest";

import { HANDLE_PATTERN, handleFromText, nextFreeHandle, toHandle, transliterateBangla } from "./handle";

describe("Bangla transliteration for handles", () => {
  it.each([
    ["শাড়ি", "shari"],
    ["লাল শাড়ি", "lal-shari"],
    ["পাঞ্জাবি", "panjabi"],
    ["কুর্তা", "kurta"],
    ["লাল", "lal"],
    ["জামা", "jama"],
    ["ঈদ", "id"],
    ["থ্রি পিস", "thri-pis"],
    ["শার্ট", "shart"],
    ["টি-শার্ট", "ti-shart"],
    ["বোরকা", "borka"],
    ["চাল", "chal"],
    ["মধু", "modhu"],
    ["কাপড়", "kapor"],
    ["বাংলা", "bangla"],
    ["রং", "rong"],
    ["সময়", "somoy"],
    ["চাঁদ", "chad"],
    ["উৎসব", "utsob"],
    ["কলকাতা", "kolkata"],
    ["ব্যাগ", "byag"],
    ["দুঃখ", "duhkh"],
    ["কৃষি", "krishi"],
  ])("%s reads as %s", (name, handle) => {
    expect(toHandle(name)).toBe(handle);
  });

  it("reads ড় the same whether typed as one letter or with a separate nukta", () => {
    expect(toHandle("শাড়ি")).toBe("shari");
    expect(toHandle("শাড়ি")).toBe("shari");
  });

  it("keeps Latin text and turns Bengali digits into digits", () => {
    expect(toHandle("R3-CAT Kurta কুর্তা")).toBe("r3-cat-kurta-kurta");
    expect(toHandle("F5-কাপড়")).toBe("f5-kapor");
    expect(toHandle("শাড়ি ২০২৬")).toBe("shari-2026");
    expect(transliterateBangla("১২৩ abc")).toBe("123 abc");
  });
});

describe("toHandle", () => {
  it("folds accents, lowercases and collapses everything else into single dashes", () => {
    expect(toHandle("  Café Crème — Été!! ")).toBe("cafe-creme-ete");
    expect(toHandle("Straße 🎉 Ærø")).toBe("strasse-aero");
    expect(toHandle("Eid 🌙 Sale!!! 50% off")).toBe("eid-sale-50-off");
  });

  it("returns an empty handle when nothing readable is left", () => {
    expect(toHandle("")).toBe("");
    expect(toHandle("🎉🎉 !!")).toBe("");
  });

  it("caps long names at 100 characters without a trailing dash", () => {
    expect(toHandle(`${"a".repeat(99)} bcd`)).toBe("a".repeat(99));
    const bangla = toHandle("লাল শাড়ি ".repeat(20));
    expect(bangla.length).toBeLessThanOrEqual(100);
    expect(bangla).toMatch(HANDLE_PATTERN);
  });
});

describe("handleFromText", () => {
  it("returns the readable handle when it is long enough", () => {
    expect(handleFromText("লাল শাড়ি", "product")).toBe("lal-shari");
  });

  it("gives a name that reads as nothing a stable resource handle", () => {
    const handle = handleFromText("🎉🎉", "product");
    expect(handle).toMatch(/^product-[a-z0-9]{4}$/);
    expect(handleFromText("🎉🎉", "product")).toBe(handle);
    expect(handleFromText("🌙", "category")).toMatch(/^category-[a-z0-9]{4}$/);
    expect(handleFromText("", "page")).toMatch(/^page-[a-z0-9]{4}$/);
  });

  it("prefixes a one- or two-character reading with the resource word", () => {
    expect(handleFromText("XL", "attribute")).toBe("attribute-xl");
    expect(handleFromText("ঈ", "post")).toBe("post-i");
  });

  it("always returns a valid handle", () => {
    for (const text of ["", "a", "🎉", "—", "ঁ", "R3-CAT Kurta কুর্তা", "x".repeat(300), "ক ".repeat(80)]) {
      const handle = handleFromText(text, "category");
      expect(handle).toMatch(HANDLE_PATTERN);
      expect(handle.length).toBeGreaterThanOrEqual(3);
      expect(handle.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("nextFreeHandle", () => {
  it("keeps a free base", () => {
    expect(nextFreeHandle("kurta", [])).toBe("kurta");
    expect(nextFreeHandle("kurta", ["kurta-2"])).toBe("kurta");
  });

  it("adds the lowest free number", () => {
    expect(nextFreeHandle("kurta", ["kurta"])).toBe("kurta-2");
    expect(nextFreeHandle("kurta", ["kurta", "kurta-2", "kurta-4"])).toBe("kurta-3");
  });

  it("trims a long base so the suffix fits in 100 characters", () => {
    const base = `${"a".repeat(98)}-b`;
    const handle = nextFreeHandle(base, [base]);
    expect(handle).toBe(`${"a".repeat(98)}-2`);
    expect(handle).toMatch(HANDLE_PATTERN);
  });
});
