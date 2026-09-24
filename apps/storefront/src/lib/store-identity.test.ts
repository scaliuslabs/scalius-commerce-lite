import { describe, expect, it } from "vitest";
import {
  buildDocumentTitle,
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

  it("applies one `Page | Store` title template", () => {
    expect(buildDocumentTitle("Footwear", "Scalius Market")).toBe("Footwear | Scalius Market");
    expect(buildDocumentTitle("About Scalius Market", "Scalius Market")).toBe("About Scalius Market");
    expect(buildDocumentTitle("", "Scalius Market")).toBe("Scalius Market");
    expect(buildDocumentTitle("Footwear", null)).toBe("Footwear");
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
