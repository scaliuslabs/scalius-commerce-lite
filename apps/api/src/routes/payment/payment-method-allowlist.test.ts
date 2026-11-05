import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { assertGatewaySelectedForCheckout, loadCheckoutGatewaySettings } from "./payment-method-allowlist";
import { BUILT_IN_PAYMENT_PROVIDERS } from "@scalius/core/modules/payments";
import { paymentMethodsDocument } from "@scalius/core/modules/settings";
import { checkoutDocument } from "@scalius/core/modules/settings";

describe("payment-method-allowlist", () => {
  let fixture: SqliteTestDatabase;

  beforeEach(() => {
    fixture = createSqliteD1Database();
  });

  afterEach(() => fixture.sqlite.close());

  it("rejects a payment method that is not enabled", async () => {
    await paymentMethodsDocument.write(fixture.db, {
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });
    await checkoutDocument.write(fixture.db, {
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      codDepositEnabled: false,
      codDepositMode: "fixed",
      codDepositAmount: 0,
      codDepositPercent: 0,
    });

    await expect(
      assertGatewaySelectedForCheckout(fixture.db, "stripe", BUILT_IN_PAYMENT_PROVIDERS),
    ).rejects.toThrow("gateway is not enabled for checkout");
  });

  it("allows COD when enabled and checkout settings permit it", async () => {
    await paymentMethodsDocument.write(fixture.db, {
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });
    await checkoutDocument.write(fixture.db, {
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      codDepositEnabled: false,
      codDepositMode: "fixed",
      codDepositAmount: 0,
      codDepositPercent: 0,
    });

    const settings = await assertGatewaySelectedForCheckout(
      fixture.db,
      "cod",
      BUILT_IN_PAYMENT_PROVIDERS,
    );
    expect(settings.checkoutMode).toBe("all");
    expect(settings.codDepositEnabled).toBe(false);
  });

  it("loadCheckoutGatewaySettings fails closed when gateway settings are missing", async () => {
    await paymentMethodsDocument.write(fixture.db, {
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });
    await checkoutDocument.write(fixture.db, {
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
      codDepositEnabled: false,
      codDepositMode: "fixed",
      codDepositAmount: 0,
      codDepositPercent: 0,
    });

    const stripe = BUILT_IN_PAYMENT_PROVIDERS.require("stripe");
    await expect(
      loadCheckoutGatewaySettings(fixture.db, undefined, stripe),
    ).rejects.toThrow();
  });
});
