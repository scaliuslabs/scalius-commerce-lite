import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FORM_SOURCE = fileURLToPath(new URL("./LocationFormDialog.tsx", import.meta.url));
const HOOK_SOURCE = fileURLToPath(new URL("./hooks/useDeliveryLocations.ts", import.meta.url));

describe("LocationFormDialog external mapping boundaries", () => {
  it("renders Pathao mapping as a first-class field instead of raw JSON editing", () => {
    const source = readFileSync(FORM_SOURCE, "utf8");

    expect(source).toContain("Pathao {locationLabel} ID");
    expect(source).toContain("setPathaoExternalId");
    expect(source).toContain("externalIds.pathao");
    expect(source).toContain("delete externalIds.pathao");
    expect(source).toContain('inputMode="numeric"');
    expect(source).not.toContain("External IDs JSON");
  });

  it("validates and normalizes Pathao IDs before save", () => {
    const source = readFileSync(HOOK_SOURCE, "utf8");

    expect(source).toContain("isPositiveIntegerPathaoId");
    expect(source).toContain("Pathao ID must be a positive whole number.");
    expect(source).toContain("normalizeExternalIds");
    expect(source).toContain("next.pathao = Number(pathaoId.trim())");
  });
});
