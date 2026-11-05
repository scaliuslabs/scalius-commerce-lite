import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { getCheckoutFlowValidationIssues } from "./flow";
import { getCheckoutFlowSettingsDocument, saveCheckoutFlowSettingsDocument } from "./flow-settings";

describe("manual COD settings remain independent of online advances", () => {
  let fixture: SqliteTestDatabase;
  beforeEach(() => { fixture = createSqliteD1Database(); });
  afterEach(() => fixture.sqlite.close());
  const base = () => ({ guestCheckoutEnabled: true, checkoutMode: "all" as const,
    partialPaymentEnabled: false, partialPaymentAmount: 0, expectedRevision: 0,
    availablePaymentMethods: ["cod"], codDepositEnabled: true, codDepositMode: "fixed" as const,
    codDepositAmount: 100, codDepositInstructions: "Transfer to store" });

  it("validates COD availability even when online advance is disabled", () => {
    expect(getCheckoutFlowValidationIssues({ ...base(), availablePaymentMethods: ["stripe"] })).toContain("Cash on delivery deposit requires Cash on Delivery to be enabled.");
  });

  it.each([0, -1])("refuses fixed deposit %i in the production settings writer", async (codDepositAmount) => {
    await expect(saveCheckoutFlowSettingsDocument(fixture.db, { ...base(), codDepositAmount })).rejects.toThrow(/deposit amount/);
    expect((await getCheckoutFlowSettingsDocument(fixture.db)).revision).toBe(0);
  });

  it.each([0, 100, 1.5])("refuses percentage %i in the production settings writer", async (codDepositPercent) => {
    await expect(saveCheckoutFlowSettingsDocument(fixture.db, { ...base(), codDepositMode: "percentage", codDepositPercent })).rejects.toThrow(/percentage/);
  });

  it("preserves omitted deposit fields and refuses incompatible flow changes", async () => {
    const first = await saveCheckoutFlowSettingsDocument(fixture.db, base());
    const partial = { guestCheckoutEnabled: true, checkoutMode: "all" as const, partialPaymentEnabled: false,
      partialPaymentAmount: 0, expectedRevision: first.revision, availablePaymentMethods: ["cod"] };
    const second = await saveCheckoutFlowSettingsDocument(fixture.db, partial);
    expect(second.codDepositAmount).toBe(100);
    expect(second.codDepositInstructions).toBe("Transfer to store");
    await expect(saveCheckoutFlowSettingsDocument(fixture.db, { ...partial,
      expectedRevision: second.revision, checkoutMode: "gateways_only", availablePaymentMethods: ["stripe"],
    })).rejects.toThrow(/Cash on delivery deposit/);
    expect((await getCheckoutFlowSettingsDocument(fixture.db)).checkoutMode).toBe("all");
  });
});
