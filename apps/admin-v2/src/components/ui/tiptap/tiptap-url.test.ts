import { describe, expect, it } from "vitest";
import {
  normalizeRichTextImageUrl,
  normalizeRichTextLinkUrl,
} from "./tiptap-url";

describe("rich-text URL inputs", () => {
  it("accepts intentional link destinations", () => {
    expect(normalizeRichTextLinkUrl(" https://example.com/path ")).toBe(
      "https://example.com/path",
    );
    expect(normalizeRichTextLinkUrl("mailto:help@example.com")).toBe(
      "mailto:help@example.com",
    );
    expect(normalizeRichTextLinkUrl("tel:+8801700000000")).toBe(
      "tel:+8801700000000",
    );
    expect(normalizeRichTextLinkUrl("/returns")).toBe("/returns");
    expect(normalizeRichTextLinkUrl("#shipping")).toBe("#shipping");
  });

  it("rejects incomplete and executable links", () => {
    expect(normalizeRichTextLinkUrl("example.com")).toBeNull();
    expect(normalizeRichTextLinkUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeRichTextLinkUrl("//other-store.example/path")).toBeNull();
    expect(normalizeRichTextLinkUrl("https://user:pass@example.com")).toBeNull();
    expect(normalizeRichTextLinkUrl("https://example.com/a b")).toBeNull();
    expect(normalizeRichTextLinkUrl("mailto:")).toBeNull();
    expect(normalizeRichTextLinkUrl("tel:")).toBeNull();
    expect(normalizeRichTextLinkUrl("#")).toBeNull();
    expect(normalizeRichTextLinkUrl(" ")).toBeNull();
  });

  it("requires secure public image URLs without embedded credentials", () => {
    expect(
      normalizeRichTextImageUrl(" https://images.example.com/item.webp?size=2 "),
    ).toBe("https://images.example.com/item.webp?size=2");
    expect(normalizeRichTextImageUrl("http://images.example.com/item.webp")).toBeNull();
    expect(normalizeRichTextImageUrl("https://user:pass@example.com/item.webp")).toBeNull();
    expect(normalizeRichTextImageUrl("data:image/png;base64,AA==")).toBeNull();
  });
});
