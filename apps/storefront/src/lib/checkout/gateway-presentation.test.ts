import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_GATEWAY_MARK_SRC,
  APP_PROVIDER_MARKS,
  appGatewayName,
  getGatewayPresentation,
  isAppGatewayId,
  SSLCOMMERZ_GATEWAY_ID,
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
    expect(getGatewayPresentation(SSLCOMMERZ_GATEWAY_ID, "Online Payment")).toMatchObject({
      buyerLabel: "Pay online",
      providerLabel: "SSLCommerz",
      markSrc: "/payment-marks/sslcommerz.png",
      markKind: "wordmark",
      hosted: true,
    });
    // Every method shows a mark in the same badge: a brandless one a plain icon.
    expect(getGatewayPresentation("cod", "Cash on Delivery")).toMatchObject({
      buyerLabel: "Cash on delivery",
      markSrc: "/payment-marks/cash.svg",
      markKind: "icon",
    });
    expect(getGatewayPresentation("gift_card", "Gift card")).toEqual({
      buyerLabel: "Gift card",
      description: "",
      providerLabel: null,
      markSrc: "/payment-marks/gift.svg",
      markKind: "icon",
      hosted: false,
    });
    expect(getGatewayPresentation("custom", "Custom pay")).toMatchObject({ markSrc: APP_GATEWAY_MARK_SRC, markKind: "icon" });
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

  it("serves each app provider's declared mark, byte for byte", () => {
    // The provider id, the plugin package and the mark its manifest declares.
    const declared: Record<string, { plugin: string; icon: string }> = {
      [SSLCOMMERZ_GATEWAY_ID]: { plugin: "bangladesh", icon: "assets/sslcommerz.png" },
      "scalius.bkash:bkash": { plugin: "bkash", icon: "assets/mark.svg" },
      "scalius.nagad:nagad": { plugin: "nagad", icon: "assets/mark.svg" },
    };
    expect(Object.keys(APP_PROVIDER_MARKS).sort()).toEqual(Object.keys(declared).sort());
    for (const [id, src] of Object.entries(APP_PROVIDER_MARKS)) {
      const { plugin, icon } = declared[id]!;
      const manifest = readFileSync(new URL(`../../../../../plugins/${plugin}/src/index.ts`, import.meta.url), "utf8");
      expect(manifest, id).toContain(`icon: "${icon}"`);
      const served = readFileSync(new URL(`../../../public${src}`, import.meta.url));
      const mark = readFileSync(new URL(`../../../../../plugins/${plugin}/${icon}`, import.meta.url));
      expect(served.equals(mark), id).toBe(true);
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
    expect(appGatewayName("stripe", gateways)).toBeNull();
    expect(appGatewayName(SSLCOMMERZ_GATEWAY_ID, gateways)).toBe("Sslcommerz");
    expect(appGatewayName(SSLCOMMERZ_GATEWAY_ID, [{ id: SSLCOMMERZ_GATEWAY_ID, name: "Online Payment" }])).toBe("Online Payment");
    expect(isAppGatewayId(BKASH)).toBe(true);
    expect(isAppGatewayId("sslcommerz")).toBe(false);
    expect(isAppGatewayId("stripe")).toBe(false);
  });
});
