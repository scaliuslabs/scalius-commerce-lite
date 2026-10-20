// @vitest-environment node
import { describe, expect, it } from "vitest";
import { objectFieldView, objectLink, type ObjectFieldContext } from "./object-fields";

const context: ObjectFieldContext = {
  media: new Map([["m1", { id: "m1", url: "https://cdn.test/m1.jpg", alt: "", width: 10, height: 10 }]]),
  currencySymbol: "৳",
  currencyCode: "BDT",
  language: "en",
};
const view = (type: string, value: string | number | boolean | unknown[], language: "en" | "bn" = "en") =>
  objectFieldView({ key: "k", name: "K", type, value }, { ...context, language });

describe("object field views", () => {
  it("links only https addresses and store paths", () => {
    expect(objectLink("https://example.com/a")).toEqual({ href: "https://example.com/a", external: true });
    expect(objectLink("/pages/stores")).toEqual({ href: "/pages/stores", external: false });
    for (const value of ["javascript:alert(1)", "http://example.com", "//evil.test", "data:text/html,x", "mailto:a@b.co", "/a b", "https://u:p@example.com"]) {
      expect(objectLink(value), value).toBeNull();
    }
    expect(view("url", "javascript:alert(1)")!.parts).toEqual([{ kind: "text", text: "javascript:alert(1)" }]);
  });

  it("formats money (`{ amountMinor, currency }`, as the API sends it), booleans and dates in the store language", () => {
    expect(view("money", { amountMinor: 125050, currency: "BDT" } as never)!.parts).toEqual([{ kind: "text", text: "৳1,250.50" }]);
    expect(view("money", { amountMinor: 1999, currency: "USD" } as never)!.parts).toEqual([{ kind: "text", text: "$19.99" }]);
    expect(view("money", { amountMinor: -5, currency: "BDT" } as never)).toBeNull();
    expect(view("money", 1250.5)).toBeNull();
    expect(view("money", "125050")).toBeNull();
    expect(view("boolean", true)!.parts).toEqual([{ kind: "text", text: "Yes" }]);
    expect(view("boolean", false, "bn")!.parts).toEqual([{ kind: "text", text: "না" }]);
    expect(view("date", "2019-04-14")!.parts).toEqual([{ kind: "text", text: "14 April 2019" }]);
    expect(view("date", "not a date")).toBeNull();
    // A date and time names its zone (the section has no store time zone).
    expect(view("date_time", "2026-03-20T04:00:00Z")!.parts[0]).toMatchObject({ kind: "text", text: expect.stringMatching(/2026.* UTC$/) });
  });

  it("reads lists, photos and colours, and hides what v1 does not draw", () => {
    expect(view("list.integer", [38, 40])!.parts).toHaveLength(2);
    expect(view("list.integer", "not a list")).toBeNull();
    expect(view("media_reference", "m1")!.parts[0]).toMatchObject({ kind: "image" });
    expect(view("media_reference", "missing")).toBeNull();
    expect(view("list.media_reference", ["m1", "missing"])!.parts).toHaveLength(1);
    expect(view("color", "#AABBCC")!.parts).toEqual([{ kind: "color", value: "#aabbcc" }]);
    expect(view("color", "red; background:url(x)")).toBeNull();
    for (const type of ["json", "product_reference", "list.variant_reference", "collection_reference"]) expect(view(type, "x"), type).toBeNull();
  });
});
