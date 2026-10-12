import { describe, expect, it } from "vitest";
import { STOREFRONT_SECTION_RENDERERS, storefrontSectionDefault } from "@scalius/shared/storefront-theme";
import { readLibrarySelection } from "./theme-preview-library";

const url = (section = "faq", page = "/") => new URL(`https://shop.test/theme-preview/library?${new URLSearchParams({ section, page, v: "test-document-1" })}`);

describe("selected library render inputs", () => {
  it.each(STOREFRONT_SECTION_RENDERERS)("uses the normal Add default for %s", (type) => {
    expect(readLibrarySelection(url(type))?.section).toEqual(storefrontSectionDefault(type, "library-section"));
  });
  it.each([
    ["/", { kind: "home" }], ["/pages/eid", { kind: "landing", slug: "eid" }],
    ["/products/one", { kind: "template", template: "product", main: 0 }],
    ["/categories/one", { kind: "template", template: "collection", main: 0 }],
    ["/collections/one", { kind: "template", template: "collection", main: 0 }],
    ["/about", { kind: "template", template: "page", main: 0 }],
    ["/cart", { kind: "template", template: "cart", main: 0 }],
  ])("recognizes intended page %s without fetching it", (path, scope) => {
    expect(readLibrarySelection(url("faq", path as string))).toMatchObject({ path, scope });
  });
  it("keeps market context separate from the logical renderer path", () => {
    expect(readLibrarySelection(url("faq", "/bn-bd/products/one"))).toMatchObject({ path: "/products/one", presence: "bn-bd" });
  });
  it.each(["https://other.test/", "//other.test/", "/account", "/checkout", "/api/write", "/theme-preview/render", "/products/a/b", "/products", "/search", "/about?q=secret", "/about#x", "/a/../about", "/%61bout"])("rejects invalid/private context %s", (path) => {
    expect(readLibrarySelection(url("faq", path))).toBeNull();
  });
  it("refuses unrecognized section keys and extra/duplicate inputs", () => {
    expect(readLibrarySelection(url("app"))).toBeNull();
    expect(readLibrarySelection(url("unknown"))).toBeNull();
    const duplicate = url(); duplicate.searchParams.append("section", "hero");
    expect(readLibrarySelection(duplicate)).toBeNull();
    const extra = url(); extra.searchParams.append("token", "not-accepted");
    expect(readLibrarySelection(extra)).toBeNull();
    const nonce = url(); nonce.searchParams.set("v", "<script>");
    expect(readLibrarySelection(nonce)).toBeNull();
  });
  it("asks the authoritative app reader to resolve shared defaults for a valid app key", () => {
    expect(readLibrarySelection(url("acme.theme/hero"))?.section).toEqual({ id: "library-section", type: "app", version: 1, settings: { app: "acme.theme/hero", values: {} } });
  });
});
