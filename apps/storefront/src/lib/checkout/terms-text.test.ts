import { describe, expect, it } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA as EN } from "@scalius/shared/checkout-language";
import { termsSegments } from "./terms-text";

const links = (terms: string | null, privacy: string | null) => ({
  terms: { label: EN.termsLinkText, href: terms },
  privacy: { label: EN.privacyLinkText, href: privacy },
});

describe("termsSegments", () => {
  it("links the published Terms and Privacy pages", () => {
    expect(termsSegments(EN.termsText, links("/terms", "/privacy"))).toEqual([
      { text: "By placing this order, you agree to our ", href: null },
      { text: "Terms of Service", href: "/terms" },
      { text: " and ", href: null },
      { text: "Privacy Policy", href: "/privacy" },
      { text: ".", href: null },
    ]);
  });

  it("keeps a policy without a page as plain text", () => {
    const segments = termsSegments(EN.termsText, links(null, "/privacy"));
    expect(segments.find((segment) => segment.text === "Terms of Service")?.href).toBeNull();
    expect(segments.map((segment) => segment.text).join("")).toBe(
      "By placing this order, you agree to our Terms of Service and Privacy Policy.",
    );
  });

  it("links the names in copy saved before the link tokens existed", () => {
    const saved = "By placing this order, you agree to our Terms of Service and Privacy Policy.";
    expect(termsSegments(saved, links("/terms", null)).filter((segment) => segment.href)).toEqual([
      { text: "Terms of Service", href: "/terms" },
    ]);
    expect(termsSegments("Custom text.", links("/terms", "/privacy"))).toEqual([
      { text: "Custom text.", href: null },
    ]);
  });
});
