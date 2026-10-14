import { describe, expect, it } from "vitest";

import { chargeCurrencyIssue } from "./payment-method-outcome";
import { paymentMethodRows, type AppPaymentProvider, type PaymentGatewayInfo } from "./payment-method-rows";

const BKASH = "scalius.bangladesh:bkash";
const NAGAD = "scalius.bangladesh:nagad";

const gateways: PaymentGatewayInfo[] = [
  { id: "stripe", label: "Stripe", pluginId: null, chargeCurrencies: "any" },
  { id: BKASH, label: "bKash", pluginId: "scalius.bkash", chargeCurrencies: ["BDT"] },
];

const provider = (id: string, overrides: Partial<AppPaymentProvider> = {}): AppPaymentProvider => ({
  id,
  pluginId: id.split(":")[0]!,
  appName: id === BKASH ? "bKash Payments" : "Nagad",
  name: id === BKASH ? "bKash" : "Nagad",
  canTestConnection: true,
  readiness: { configured: true, enabled: true, usable: true, missingFields: [], credentialErrors: [] },
  environment: "test",
  ...overrides,
});

const ready = { configured: true, enabled: true, usable: true, providerEnabled: true };

describe("payment method rows", () => {
  it("lists turned-on methods in checkout order, then cash, the API's gateways and apps not offered yet", () => {
    const nagad = provider(NAGAD, {
      readiness: { configured: true, enabled: false, usable: false, missingFields: [], credentialErrors: [], blockedReason: "Activate Nagad in Apps to use it." },
    });
    const rows = paymentMethodRows({
      enabledMethods: [BKASH, "cod"],
      gateways,
      gatewayStatus: { cod: ready, stripe: ready, [BKASH]: { ...ready, environment: "live" } },
      appProviders: [provider(BKASH), nagad],
      appProvidersKnown: true,
    });

    expect(rows.map((row) => [row.id, row.kind])).toEqual([
      [BKASH, "app"],
      ["cod", "cod"],
      ["stripe", "built_in"],
      [NAGAD, "app"],
    ]);
    expect(rows[0]).toMatchObject({
      name: "bKash",
      appName: "bKash Payments",
      pluginId: "scalius.bkash",
      installed: true,
      canTestConnection: true,
      chargeCurrencies: ["BDT"],
      // The checkout's own verdict wins over the app list's.
      status: { environment: "live" },
    });
    // An inactive app's readiness, failing closed with the server's reason.
    expect(rows[3]).toMatchObject({
      name: "Nagad",
      status: { usable: false, providerEnabled: false, blockedReason: "Activate Nagad in Apps to use it." },
    });
  });

  it("shows a pack provider's own mark", () => {
    const pack = provider("scalius.bangladesh:sslcommerz", {
      appName: "Bangladesh pack", name: "SSLCommerz", appIcon: "/icon/pack.svg", icon: "/icon/sslcommerz.png",
    });
    const rows = paymentMethodRows({
      enabledMethods: ["scalius.bangladesh:sslcommerz", "cod"],
      gateways: gateways.slice(0, 1),
      gatewayStatus: { cod: ready },
      appProviders: [pack],
      appProvidersKnown: true,
    });
    expect(rows.find((row) => row.id === "scalius.bangladesh:sslcommerz")).toMatchObject({ kind: "app", name: "SSLCommerz", appIcon: "/icon/sslcommerz.png" });
  });

  it("keeps a saved app method whose app was removed, so it can be turned off", () => {
    const input = {
      enabledMethods: ["cod", "gone.app:wallet-pay"],
      gateways: gateways.slice(0, 1),
      gatewayStatus: { cod: ready },
      appProviders: [],
    };
    const removed = paymentMethodRows({ ...input, appProvidersKnown: true }).find((row) => row.id === "gone.app:wallet-pay");
    expect(removed).toMatchObject({ kind: "app", name: "Wallet pay", pluginId: "gone.app", installed: false, status: undefined });
    // Until the installed apps are read, nothing is called removed.
    expect(paymentMethodRows({ ...input, appProvidersKnown: false }).find((row) => row.id === "gone.app:wallet-pay")?.installed).toBe(true);
  });
});

describe("charge currency eligibility", () => {
  it("passes a gateway that charges any currency or the store's", () => {
    expect(chargeCurrencyIssue("any", undefined)).toBeNull();
    expect(chargeCurrencyIssue(["BDT"], "BDT")).toBeNull();
    expect(chargeCurrencyIssue(["BDT"], "bdt")).toBeNull();
  });

  it("names the needed currencies otherwise, and fails closed while the store currency is unknown", () => {
    expect(chargeCurrencyIssue(["BDT"], "USD")).toEqual(["BDT"]);
    expect(chargeCurrencyIssue(["BDT", "INR"], undefined)).toEqual(["BDT", "INR"]);
  });
});
