import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("./CurrencySettingsBuilder.tsx", import.meta.url),
  "utf8",
);

describe("currency settings safety boundaries", () => {
  it("disables currency selection when catalog or order history locks the code", () => {
    expect(SOURCE).toContain("type CurrencySettings = CurrencySettingsPayload");
    expect(SOURCE).toContain("!values.currencyCodeLocked ? (");
    expect(SOURCE).toContain(
      "is locked because catalog or order amounts already exist.",
    );
    expect(SOURCE).toContain(
      "Changing stored price currency requires a dedicated migration.",
    );
  });

  it("validates the exchange rate and surfaces rejected saves", () => {
    expect(SOURCE).toContain("Number.isFinite(rate) && rate > 0");
    // The page-level save bar owns Save/Discard; an invalid rate, an unloaded
    // read, or a clean draft all keep Save locked.
    expect(SOURCE).toContain(
      "const saveLocked = isSaving || !isLoaded || !isDirty || !isExchangeRateValid;",
    );
    expect(SOURCE).toContain("saveDisabled={saveLocked}");
    expect(SOURCE).toContain("<FieldError id=\"usd-exchange-rate-error\">");
    expect(SOURCE).toContain('<Alert variant="destructive" role="alert">');
  });

  it("saves through one contextual save bar instead of a per-card button row", () => {
    expect(SOURCE).toContain("<ContextualSaveBar");
    expect(SOURCE).toContain("isDirty={isDirty || isSaving}");
    expect(SOURCE).toContain("allowSamePathNavigation");
    expect(SOURCE).toContain('saveLabel="Save currency"');
    expect(SOURCE).toContain("onSave={() => void submit()}");
    expect(SOURCE).not.toContain("<UnsavedChangesGuard");
    expect(SOURCE).not.toContain("animate-spin");
  });

  it("does not send the read-only lock state back in the settings payload", () => {
    const savePayload = SOURCE.slice(
      SOURCE.indexOf("saveFn:"),
      SOURCE.indexOf("defaultValues:"),
    );

    expect(savePayload).not.toContain("currencyCodeLocked");
  });
});
