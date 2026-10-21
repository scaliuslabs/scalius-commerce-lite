import { describe, expect, it } from "vitest";
import { storefrontIncidentReportSchema } from "@scalius/shared/plugins/storefront-incidents";
import { storefrontIncidentLine } from "./storefront-incidents";

const release = "c".repeat(64);

describe("storefront incident lines", () => {
  it("say what the store could not show, why, and what it showed instead", () => {
    expect(storefrontIncidentLine({ pluginId: "acme.skin", release, kind: "skin", type: "ribbon_card", target: "product_card", reason: "error", detail: "Error: boom." })).toEqual({
      level: "error",
      source: "storefront:skin:ribbon_card",
      message: "Your store couldn't show the product card design \"ribbon_card\": its code failed: Error: boom. It showed your theme's own design instead.",
      fields: { kind: "skin", type: "ribbon_card", target: "product_card", reason: "error", release: "cccccccccccc" },
    });
    const late = storefrontIncidentLine({ pluginId: "acme.skin", release, kind: "section", type: "promo", reason: "late" });
    expect(late.level).toBe("warn");
    expect(late.message).toBe("Your store couldn't show the section \"promo\": it took longer than 250 ms to answer. It left it out of the page.");
    expect(storefrontIncidentLine({ pluginId: "acme.skin", release, kind: "skin", type: "bold", target: "section:usp_strip", reason: "unavailable" }).message)
      .toContain("the \"usp_strip\" section design \"bold\"");
  });

  it("accepts only bounded, well-formed reports", () => {
    const one = { pluginId: "acme.skin", release, kind: "section", type: "promo", reason: "late" };
    expect(storefrontIncidentReportSchema.safeParse({ incidents: [one] }).success).toBe(true);
    expect(storefrontIncidentReportSchema.safeParse({ incidents: [{ ...one, page: "/checkout" }] }).success).toBe(false);
    expect(storefrontIncidentReportSchema.safeParse({ incidents: Array.from({ length: 21 }, () => one) }).success).toBe(false);
    expect(storefrontIncidentReportSchema.safeParse({ incidents: [{ ...one, type: "<script>" }] }).success).toBe(false);
  });
});
