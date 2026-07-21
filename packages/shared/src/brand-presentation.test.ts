import { describe, expect, it } from "vitest";

import {
  HEADER_LOGO_WIDTH_DEFAULT,
  getMobileHeaderLogoWidth,
  normalizeHeaderLogoWidth,
} from "./brand-presentation";

describe("brand presentation", () => {
  it("normalizes legacy and malformed header logo widths", () => {
    expect(normalizeHeaderLogoWidth(undefined)).toBe(HEADER_LOGO_WIDTH_DEFAULT);
    expect(normalizeHeaderLogoWidth(Number.NaN)).toBe(HEADER_LOGO_WIDTH_DEFAULT);
    expect(normalizeHeaderLogoWidth(20)).toBe(80);
    expect(normalizeHeaderLogoWidth(400)).toBe(240);
    expect(normalizeHeaderLogoWidth(187)).toBe(190);
  });

  it("derives a safe mobile width without adding another merchant setting", () => {
    expect(getMobileHeaderLogoWidth(120)).toBe(120);
    expect(getMobileHeaderLogoWidth(220)).toBe(160);
  });
});
