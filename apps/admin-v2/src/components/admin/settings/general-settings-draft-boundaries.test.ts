import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("general settings draft boundaries", () => {
  it.each([
    "BusinessSettingsBuilder.tsx",
    "CurrencySettingsBuilder.tsx",
    "AllowedCountriesBuilder.tsx",
  ])("guards dirty %s drafts from route changes", (name) => {
    const source = readSource(name);

    expect(source).toContain("<UnsavedChangesGuard");
    expect(source).toContain("isDirty={isDirty}");
    expect(source).toMatch(/isSubmitting=\{(?:isSaving|saving)\}/);
  });

  it.each([
    ["BusinessSettingsBuilder.tsx", "Save business"],
    ["CurrencySettingsBuilder.tsx", "Save currency"],
    ["AllowedCountriesBuilder.tsx", "Save country policy"],
  ])("keeps %s saves deliberate and phone-friendly", (name, saveLabel) => {
    const source = readSource(name);

    expect(source).toContain("!isDirty");
    expect(source).toContain("Reset");
    expect(source).toContain(saveLabel);
    expect(source).toContain("min-h-11");
  });

  it("previews the invoice logo through the no-crop admin preset", () => {
    const source = readSource("BusinessSettingsBuilder.tsx");

    expect(source).toContain("normalizePublicMediaUrl");
    expect(source).toContain("ADMIN_IMAGE_PRESETS.invoiceLogo");
    expect(source).toContain("object-contain");
    expect(source).toContain("invoiceLogoInvalid");
  });
});
