import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_GATEWAY_MARKS,
  APP_GATEWAY_MARK_SRC,
  appGatewayName,
  getGatewayPresentation,
  isAppGatewayId,
} from "./gateway-presentation";

const BKASH = "scalius.bkash:bkash";

describe("gateway presentation", () => {
  it("keeps the built-in gateways exactly as they were", () => {
    expect(getGatewayPresentation("stripe", "Card")).toEqual({
      buyerLabel: "Credit or debit card",
      description: "Pay securely by card",
      providerLabel: "Stripe",
      markSrc: "/payment-marks/stripe-blurple.svg",
      markKind: "wordmark",
      hosted: false,
    });
    expect(getGatewayPresentation("sslcommerz", "SSLCommerz")).toMatchObject({
      buyerLabel: "Pay online",
      providerLabel: "SSLCommerz",
      markSrc: "/payment-marks/sslcommerz.png",
      markKind: "wordmark",
      hosted: true,
    });
    // A gift card is the tender itself: no mark, as before.
    expect(getGatewayPresentation("gift_card", "Gift card")).toEqual({
      buyerLabel: "Gift card",
      description: "",
      providerLabel: null,
      markSrc: null,
      markKind: "none",
      hosted: true,
    });
  });

  it("shows an app's wallet by its checkout name with its logo, else a neutral wallet mark", () => {
    expect(getGatewayPresentation(BKASH, "bKash")).toEqual({
      buyerLabel: "bKash",
      description: "",
      providerLabel: null,
      markSrc: "/payment-marks/bkash.svg",
      markKind: "wordmark",
      hosted: true,
    });
    expect(getGatewayPresentation("scalius.nagad:nagad", "Nagad")).toMatchObject({ markSrc: "/payment-marks/nagad.svg", markKind: "wordmark" });
    expect(getGatewayPresentation("acme.pay:wallet", "Acme wallet")).toMatchObject({ markSrc: APP_GATEWAY_MARK_SRC, markKind: "icon" });
  });

  it("serves the wallet apps' own listing icons, byte for byte", () => {
    for (const [pluginId, src] of Object.entries(APP_GATEWAY_MARKS)) {
      const app = pluginId.split(".")[1];
      const served = readFileSync(new URL(`../../../public${src}`, import.meta.url));
      const icon = readFileSync(new URL(`../../../../../plugins/${app}/assets/icon.svg`, import.meta.url));
      expect(served.equals(icon), pluginId).toBe(true);
    }
  });

  it("never shows an app's stored id, even when a caller passes it as the label", () => {
    expect(getGatewayPresentation(BKASH, BKASH).buyerLabel).toBe("Bkash");
    expect(getGatewayPresentation("acme.pay:nagad-wallet", "").buyerLabel).toBe("Nagad wallet");
  });

  it("names an app gateway from the store's checkout config, else its provider id", () => {
    const gateways = [{ id: "cod", name: "Cash on Delivery" }, { id: BKASH, name: "bKash" }];
    expect(appGatewayName(BKASH, gateways)).toBe("bKash");
    expect(appGatewayName("scalius.nagad:nagad", gateways)).toBe("Nagad");
    expect(appGatewayName(BKASH, [{ id: BKASH, name: "  " }])).toBe("Bkash");
    expect(appGatewayName("sslcommerz", gateways)).toBeNull();
    expect(isAppGatewayId(BKASH)).toBe(true);
    expect(isAppGatewayId("sslcommerz")).toBe(false);
  });
});
