import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("general settings draft boundaries", () => {
  it.each([
    "BusinessSettingsBuilder.tsx",
    "CurrencySettingsBuilder.tsx",
    "AllowedCountriesBuilder.tsx",
    "AuthSettingsBuilder.tsx",
    "MediaSettingsBuilder.tsx",
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
    ["AuthSettingsBuilder.tsx", "Save changes"],
    ["MediaSettingsBuilder.tsx", "Save changes"],
  ])("keeps %s saves deliberate and phone-friendly", (name, saveLabel) => {
    const source = readSource(name);

    expect(source).toMatch(/!isDirty|\{isDirty \? \(/);
    expect(source).toContain("Reset");
    expect(source).toContain(saveLabel);
    expect(source).toContain("min-h-11");
  });

  it("keeps the full country list behind an explicit bounded picker", () => {
    const source = readSource("AllowedCountriesBuilder.tsx");

    expect(source).toContain('aria-controls="country-picker"');
    expect(source).toContain("{pickerOpen ? (");
    expect(source).toContain("max-h-64 overflow-y-auto");
    expect(source).toContain("Edit countries");
  });

  it("previews the invoice logo through the no-crop admin preset", () => {
    const source = readSource("BusinessSettingsBuilder.tsx");

    expect(source).toContain("normalizePublicMediaUrl");
    expect(source).toContain("ADMIN_IMAGE_PRESETS.invoiceLogo");
    expect(source).toContain("object-contain");
    expect(source).toContain("invoiceLogoInvalid");
    expect(source).toContain('<MediaManager');
    expect(source).toContain('setValue("invoiceLogoUrl", file.url)');
    expect(source).toContain("Change logo");
    expect(source).toContain("Image URL");
  });
});
