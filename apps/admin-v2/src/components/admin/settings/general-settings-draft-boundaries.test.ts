import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (name: string) =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("general settings draft boundaries", () => {
  it.each([
    "BusinessSettingsBuilder.tsx", "CurrencySettingsBuilder.tsx", "AuthSettingsBuilder.tsx",
    "MediaSettingsBuilder.tsx", "AllowedCountriesBuilder.tsx", "EmailSettingsForm.tsx",
    "../SeoSettingsBuilder.tsx", "../StorefrontUrlBuilder.tsx", "../SecuritySettingsBuilder.tsx",
  ])("allows retained %s drafts to navigate between settings sections", (name) => {
    // `allowSamePathNavigation` is the ContextualSaveBar spelling of the same
    // rule: moving between sections of one settings page is not "leaving".
    expect(readSource(name).includes("allowSamePathNavigation")).toBe(true);
  });

  it.each([
    ["EmailSettingsForm.tsx", "dirty || saveMutation.isPending"],
    ["../SecuritySettingsBuilder.tsx", "dirty || hasPendingInput || saveMutation.isPending"],
  ])("keeps pending %s work protected when leaving the workspace", (name, dirtyExpression) => {
    const source = readSource(name);
    // The save bar stays mounted through the in-flight write, so the guard is
    // still armed while the confirming read settles.
    expect(source.includes(`isDirty={${dirtyExpression}}`)).toBe(true);
    expect(source).toContain("<ContextualSaveBar");
    expect(source).toContain("allowSamePathNavigation");
  });

  it("keeps the theme workspace guarded through publish and conflict recovery", () => {
    // The theme editor is an immersive workspace with its own publish flow, so
    // it keeps the standalone guard rather than a contextual save bar.
    const source = readSource("ThemeSettingsPage.tsx");
    expect(source).toContain(
      "isDirty={dirty || operation !== null || Boolean(conflict)}",
    );
    expect(source).toContain("isSubmitting={false}");
    expect(source).toContain("allowSamePathStateNavigation");
  });

  it.each([
    "BusinessSettingsBuilder.tsx",
    "CurrencySettingsBuilder.tsx",
    "AuthSettingsBuilder.tsx",
    "MediaSettingsBuilder.tsx",
    "../SeoSettingsBuilder.tsx",
  ])("guards dirty %s drafts from route changes", (name) => {
    const source = readSource(name);

    // One contextual save bar per page owns both the save pair and the
    // navigation guard; it stays up while the write is in flight.
    expect(source).toContain("<ContextualSaveBar");
    expect(source).toContain("isDirty={isDirty || isSaving}");
    expect(source).toContain("saving={isSaving}");
    expect(source).not.toContain("<UnsavedChangesGuard");
  });

  it("keeps the separate country-policy editor guarded", () => {
    const source = readSource("AllowedCountriesBuilder.tsx");
    expect(source).toContain("<ContextualSaveBar");
    expect(source).toContain("isDirty={isDirty || saving}");
    expect(source).toContain("saving={saving}");
    expect(source).not.toContain("<UnsavedChangesGuard");
  });

  it.each([
    ["BusinessSettingsBuilder.tsx", "Save business"],
    ["CurrencySettingsBuilder.tsx", "Save currency"],
    ["AllowedCountriesBuilder.tsx", "Save country policy"],
    ["AuthSettingsBuilder.tsx", "Save sign-in settings"],
    ["MediaSettingsBuilder.tsx", "Save changes"],
  ])("keeps %s saves deliberate and phone-friendly", (name, saveLabel) => {
    const source = readSource(name);

    // The bar only appears while the page is dirty, and its Save stays locked
    // until the draft is both loaded and actually changed.
    expect(source).toMatch(/saveDisabled=\{/);
    expect(source).toContain("onDiscard=");
    expect(source).toContain(`saveLabel="${saveLabel}"`);
    expect(source).toContain("min-h-11");
    expect(source).not.toContain("Save changes\n");
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
