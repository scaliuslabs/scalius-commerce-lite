import { describe, expect, it } from "vitest";

import { validateThemeSearch } from "./theme";

describe("theme settings route search", () => {
  it("keeps the selected theme workspace in the URL", () => {
    expect(validateThemeSearch({ section: "colors" })).toEqual({
      section: "colors",
      previewPath: "/",
      previewDevice: "desktop",
    });
    expect(validateThemeSearch({
      section: "unknown",
      previewPath: "/products/linen-shirt",
      previewDevice: "mobile",
    })).toEqual({
      section: "system",
      previewPath: "/products/linen-shirt",
      previewDevice: "mobile",
    });
  });
});
