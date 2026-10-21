import { describe, expect, it } from "vitest";
import {
  isListingFilterSubmission,
  listingFilterRedirect,
  listingFilterSearchParams,
} from "./listing-filter-redirect";

const form = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`https://shop.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
  });

describe("listing filter post/redirect/get", () => {
  it("answers a filter form post with a 303 to the GET listing URL, empty fields dropped", async () => {
    const response = await listingFilterRedirect(form(
      "/categories/footwear",
      "option.color=black&option.color=sage&option.size=&hasDiscount=true&q=+red++shoes+&minPrice=",
    ));
    expect(response!.status).toBe(303);
    expect(response!.headers.get("Location")).toBe(
      "/categories/footwear?option.color=black&option.color=sage&hasDiscount=true&q=red+shoes",
    );
    expect(response!.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response!.text()).toBe("");
  });

  it("keeps a presence prefix and lands on the bare listing when nothing is selected", async () => {
    const response = await listingFilterRedirect(form("/bn/categories/footwear", "option.size=&inStock="));
    expect(response!.headers.get("Location")).toBe("/bn/categories/footwear");
  });

  it("covers every page that renders the filter form", () => {
    for (const path of ["/categories/a", "/brands/b", "/collections/c", "/search", "/search/", "/en-in/brands/b"]) {
      expect(isListingFilterSubmission(form(path, "x=1")), path).toBe(true);
    }
  });

  it("leaves other posts, other paths and GETs alone", async () => {
    expect(await listingFilterRedirect(form("/localization", "country_code=BD"))).toBeNull();
    expect(await listingFilterRedirect(form("/products/p", "a=1"))).toBeNull();
    expect(await listingFilterRedirect(form("/categories", "a=1"))).toBeNull();
    expect(await listingFilterRedirect(form("/categories/a", "{}", { "Content-Type": "application/json" }))).toBeNull();
    expect(await listingFilterRedirect(new Request("https://shop.test/categories/a?x=1"))).toBeNull();
  });

  it("refuses an oversized body without rendering", async () => {
    const response = await listingFilterRedirect(form("/categories/a", `q=${"a".repeat(40_000)}`));
    expect(response!.status).toBe(413);
  });

  it("drops nameless fields", () => {
    expect(listingFilterSearchParams("=x&a=1").toString()).toBe("a=1");
  });
});
