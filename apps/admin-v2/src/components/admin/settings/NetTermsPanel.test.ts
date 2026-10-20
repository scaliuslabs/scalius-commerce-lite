import { describe, expect, it } from "vitest";
import { NET_TERMS_TAGS_MAX } from "@scalius/shared/payment-terms";
import { parseNetTermsTags } from "./NetTermsPanel";

describe("invoice customer tags", () => {
  it("reads typed tags as Customers → Tags stores them: trimmed, lowercase, once each", () => {
    expect(parseNetTermsTags(" Wholesale, b2b ,,WHOLESALE, ")).toEqual(["wholesale", "b2b"]);
    expect(parseNetTermsTags("")).toEqual([]);
  });

  it("keeps at most the tags the settings take", () => {
    const many = Array.from({ length: NET_TERMS_TAGS_MAX + 5 }, (_, index) => `tag${index}`).join(",");
    expect(parseNetTermsTags(many)).toHaveLength(NET_TERMS_TAGS_MAX);
  });
});
