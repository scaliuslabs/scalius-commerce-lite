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
    expect(SOURCE).toContain(
      "disabled={isSaving || !isLoaded || !isDirty || !isExchangeRateValid}",
    );
    expect(SOURCE).toContain('<Alert variant="destructive" role="alert">');
  });

  it("does not send the read-only lock state back in the settings payload", () => {
    const savePayload = SOURCE.slice(
      SOURCE.indexOf("saveFn:"),
      SOURCE.indexOf("defaultValues:"),
    );

    expect(savePayload).not.toContain("currencyCodeLocked");
  });
});
