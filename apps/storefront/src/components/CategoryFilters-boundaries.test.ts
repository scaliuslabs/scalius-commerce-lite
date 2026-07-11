import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./CategoryFilters.tsx", import.meta.url)),
  "utf8",
);

describe("buyer catalog facet controls", () => {
  it("supports multi-select values and preserves repeated URL parameters", () => {
    expect(source).toContain("selected.includes(value)");
    expect(source).toContain("finalParams.append(key, selectedValue)");
    expect(source).toContain("aria-pressed={selected}");
    expect(source).toContain("Selected filters");
  });

  it("shows result counts and disables only zero-result unselected values", () => {
    expect(source).toContain("const disabled = count === 0 && !selected");
    expect(source).toContain("disabled={disabled}");
    expect(source).toContain("{count}");
  });
});
