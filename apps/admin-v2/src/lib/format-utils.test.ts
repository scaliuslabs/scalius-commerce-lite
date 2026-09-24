import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import { getPlainText } from "./format-utils";

describe("rich text as a search snippet", () => {
  it("shows stored Bangla as Bangla, not character references", () => {
    const stored = sanitizeHtml("<p>৭ দিনের মধ্যে পণ্য ফেরত &amp; বদল</p>");
    expect(stored).toBe("<p>৭ দিনের মধ্যে পণ্য ফেরত &amp; বদল</p>");
    expect(getPlainText(stored, 320)).toBe("৭ দিনের মধ্যে পণ্য ফেরত & বদল");
  });

  it("decodes references already stored by older saves and truncates the text, not the markup", () => {
    expect(getPlainText("<p>&#x9ed; &#x9a6;&#x9bf;&#x9a8;</p>", 320)).toBe("৭ দিন");
    expect(getPlainText("<p>Buy <b>two</b> panjabi</p>", 7)).toBe("Buy two...");
  });
});
