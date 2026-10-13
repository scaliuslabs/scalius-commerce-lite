// @vitest-environment node
// Workers Request/Response semantics: happy-dom hides Cookie, Sec-* request headers and Set-Cookie.
import { describe, expect, it } from "vitest";
import { showsThemePreviewBar, themePreviewBarCopy } from "./theme-preview-bar";

const request = (headers: Record<string, string> = {}) => new Request("https://shop.test/", { headers });

describe("theme preview bar", () => {
  it("speaks the store's language", () => {
    expect(themePreviewBarCopy("en-US")).toEqual({ label: "Previewing unpublished theme", exit: "Exit preview" });
    expect(themePreviewBarCopy("bn")).toEqual({ label: "অপ্রকাশিত থিমের প্রিভিউ দেখছেন", exit: "প্রিভিউ বন্ধ করুন" });
    expect(themePreviewBarCopy(undefined).exit).toBe("Exit preview");
  });

  it("shows only under a live preview, and not inside the editor's frame", () => {
    expect(showsThemePreviewBar(true, request({ "Sec-Fetch-Dest": "document" }))).toBe(true);
    expect(showsThemePreviewBar(true, request())).toBe(true);
    expect(showsThemePreviewBar(true, request({ "Sec-Fetch-Dest": "iframe" }))).toBe(false);
    expect(showsThemePreviewBar(false, request({ "Sec-Fetch-Dest": "document" }))).toBe(false);
  });
});
