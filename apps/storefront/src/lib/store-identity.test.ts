import { describe, expect, it } from "vitest";
import {
  buildDocumentTitle,
  resolveStoreDisplayName,
  resolveStoreName,
  resolveStorePhone,
  resolveStoreSocialLinks,
  telHref,
  whatsappHref,
} from "./store-identity";

describe("store identity", () => {
  it("uses the Business settings name everywhere, legal name as fallback", () => {
    expect(resolveStoreName({ companyName: " Scalius Market ", legalName: "Scalius Labs" })).toBe("Scalius Market");
    expect(resolveStoreName({ companyName: "", legalName: "Scalius Labs" })).toBe("Scalius Labs");
    expect(resolveStoreName(undefined)).toBeNull();
  });

  it("prefers the Business settings phone over the header field", () => {
    expect(resolveStorePhone({ phone: "01774452222" }, "01600608630")).toBe("01774452222");
    expect(resolveStorePhone({ phone: " " }, "01600608630")).toBe("01600608630");
    expect(resolveStorePhone(null, "")).toBeNull();
  });

  it("applies one `Page | Store` title template and never a second brand", () => {
    expect(buildDocumentTitle("Footwear", "Scalius Market")).toBe("Footwear | Scalius Market");
    expect(buildDocumentTitle("About Scalius Market", "Scalius Market")).toBe("About Scalius Market");
    expect(buildDocumentTitle("", "Scalius Market")).toBe("Scalius Market");
    expect(buildDocumentTitle("Footwear", null)).toBe("Footwear");
    // Merchant SEO titles that already carry a brand segment are used as written.
    expect(buildDocumentTitle("Footwear | Scalius Market", "Scalius Labs")).toBe("Footwear | Scalius Market");
    expect(buildDocumentTitle("About Scalius Market | Scalius", "Scalius Labs")).toBe("About Scalius Market | Scalius");
    expect(buildDocumentTitle("Footwear | Scalius Market – Page 2", "Scalius Labs")).toBe("Footwear | Scalius Market – Page 2");
    // A plain page title keeps its pagination suffix and gains the store name.
    expect(buildDocumentTitle("Footwear – Page 2", "Scalius Labs")).toBe("Footwear – Page 2 | Scalius Labs");
    // Hyphens inside product names are not brand separators.
    expect(buildDocumentTitle("Block Print Wool Shawl - 2027", "Scalius Labs")).toBe("Block Print Wool Shawl - 2027 | Scalius Labs");
  });

  it("falls back to the Store URL host when the store has no name", () => {
    expect(resolveStoreDisplayName({ companyName: "" }, "https://storefront.scalius.com")).toBe("storefront.scalius.com");
    expect(resolveStoreDisplayName({ companyName: "Scalius Labs" }, "https://x.test")).toBe("Scalius Labs");
    expect(resolveStoreDisplayName(null, "")).toBeNull();
  });

  it("builds call and WhatsApp links from local, international and Bangla-digit numbers", () => {
    expect(telHref("01600-608630")).toBe("tel:+8801600608630");
    expect(whatsappHref("+880 1600 608630")).toBe("https://wa.me/8801600608630");
    expect(whatsappHref("০১৬০০৬০৮৬৩০")).toBe("https://wa.me/8801600608630");
    expect(whatsappHref("")).toBeNull();
  });

  it("merges header and footer socials into one set and fixes numberless WhatsApp links", () => {
    const links = resolveStoreSocialLinks(
      [
        [
          { label: "Facebook", url: "facebook.com/store" },
          { label: "WhatsApp", url: "https://web.whatsapp.com/" },
        ],
        [
          { label: "Facebook", url: "https://facebook.com/store/" },
          { label: "YouTube", url: "https://youtube.com/@store" },
          { label: "Chat", url: "https://wa.me/8801711111111" },
        ],
      ],
      "01600608630",
    );
    expect(links.map((link) => link.url)).toEqual([
      "https://facebook.com/store",
      "https://wa.me/8801600608630",
      "https://youtube.com/@store",
      "https://wa.me/8801711111111",
    ]);
  });

  it("drops a numberless WhatsApp link when the store has no phone", () => {
    expect(resolveStoreSocialLinks([[{ label: "WhatsApp", url: "https://web.whatsapp.com" }]], null)).toEqual([]);
  });
});
