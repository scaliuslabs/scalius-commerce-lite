import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATE_RANGE_PICKER_SOURCE = fileURLToPath(
  new URL("./DateRangePickerWithPresets.tsx", import.meta.url),
);

describe("DateRangePickerWithPresets boundaries", () => {
  it("keeps quick selects on calendar-day boundaries", () => {
    const source = readFileSync(DATE_RANGE_PICKER_SOURCE, "utf8");

    expect(source).toContain("subDays(startOfToday(), 1)");
    expect(source).toContain("subDays(startOfToday(), 6)");
    expect(source).toContain("subDays(startOfToday(), 29)");
    expect(source).not.toContain("subDays(new Date(), 7)");
    expect(source).not.toContain("subDays(new Date(), 30)");
  });
});
