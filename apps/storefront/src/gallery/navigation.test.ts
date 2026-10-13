// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { galleryEntries } from "./entries";
import { cleanGalleryUrl, galleryContextId, galleryNavigationRedirect, galleryHistoryScript } from "./navigation.mjs";

const origin = "http://127.0.0.1:4799";
const url = (path: string) => new URL(path, origin);
const valid = (id: string) => ["case-a", "case-b"].includes(id);
const context = (path: string, referer?: string) => galleryContextId(url(path), referer, valid);

describe("local gallery navigation context", () => {
  it("accepts every actual case id in both seed paths and navigation URLs", () => {
    const entries = galleryEntries();
    const ids = new Set(entries.map((entry) => entry.id));
    for (const entry of entries) {
      expect(galleryContextId(url(`/__gallery/e/${encodeURIComponent(entry.id)}`), undefined, (id) => ids.has(id))).toBe(entry.id);
      expect(galleryContextId(url(`/products/x?__gallery_entry=${encodeURIComponent(entry.id)}`), undefined, (id) => ids.has(id))).toBe(entry.id);
      expect(() => galleryHistoryScript(entry.id)).not.toThrow();
    }
  });

  it("carries the selected case through a real navigation and a reload without a Referer", () => {
    const first = url("/products/jamdani-saree?variant=sku_0");
    const selected = context(first.href, `${origin}/__gallery/e/case-a`);
    const redirect = galleryNavigationRedirect(first, selected, { "sec-fetch-dest": "document" }, true);
    expect(redirect).toBe("/products/jamdani-saree?variant=sku_0&__gallery_entry=case-a");
    expect(context(redirect!)).toBe("case-a");
    expect(cleanGalleryUrl(url(redirect!)).href).toBe(first.href);
    expect(context("/api/v1/products", url(redirect!).href)).toBe("case-a");
  });

  it("keeps two tabs independent and explicit URL context authoritative", () => {
    expect(context("/products/same?__gallery_entry=case-a", `${origin}/__gallery/e/case-b`)).toBe("case-a");
    expect(context("/api/v1/products", `${origin}/products/same?__gallery_entry=case-b`)).toBe("case-b");
    expect(context("/api/v1/products", `${origin}/products/same?__gallery_entry=case-a`)).toBe("case-a");
  });

  it("refuses unknown, ambiguous, cross-origin and missing context", () => {
    for (const path of ["/products/x?__gallery_entry=unknown", "/products/x?__gallery_entry=", "/products/x?__gallery_entry=case-a&__gallery_entry=case-b"]) {
      expect(context(path, `${origin}/__gallery/e/case-a`)).toBeNull();
    }
    expect(context("/products/x", "https://other.test/__gallery/e/case-a")).toBeNull();
    expect(context("/products/x")).toBeNull();
    expect(context("/products/x", "invalid URL")).toBeNull();
  });

  it("does not redirect fragments, endpoints, or an already selected document", () => {
    expect(galleryNavigationRedirect(url("/navigation/panels"), "case-a", { "sec-fetch-dest": "empty" }, true)).toBeNull();
    expect(galleryNavigationRedirect(url("/api/reviews/prod_0"), "case-a", { accept: "text/html" }, false)).toBeNull();
    expect(galleryNavigationRedirect(url("/products/x?__gallery_entry=case-a"), "case-a", { "sec-fetch-dest": "document" }, true)).toBeNull();
    expect(galleryNavigationRedirect(url("/products/x"), "case-a", { accept: "text/html" }, true)).toContain("__gallery_entry=case-a");
  });

  it("preserves only same-origin history replacements used by load more", () => {
    const script = galleryHistoryScript("case-a");
    const calls: unknown[][] = [];
    const history = { pushState: (...args: unknown[]) => calls.push(args), replaceState: (...args: unknown[]) => calls.push(args) };
    runInNewContext(script.replace(/^<script[^>]*>|<\/script>$/g, ""), { history, URL, location: { href: `${origin}/search?page=1`, origin } });
    history.replaceState({ page: 2 }, "", "/search?page=2#results");
    expect(calls[0]).toEqual([{ page: 2 }, "", `${origin}/search?page=2&__gallery_entry=case-a#results`]);
    history.pushState(null, "", "https://other.test/shop");
    expect(calls[1]).toEqual([null, "", "https://other.test/shop"]);
    history.replaceState(null, "", null);
    expect(calls[2]).toEqual([null, "", null]);
    expect(() => galleryHistoryScript("</script>")).toThrow("Invalid gallery entry");
  });

  it("limits context to the dev server and suppresses cross-origin Referers", () => {
    const server = readFileSync(new URL("../../scripts/gallery-server.mjs", import.meta.url), "utf8");
    expect(server).toContain('process.env.NODE_ENV === "production"');
    expect(server).toContain('"Referrer-Policy": "same-origin"');
    expect(server).not.toContain("Set-Cookie");
    expect(server).toContain("finalizeHtml(await rendered.text(), modulePath, fixtureApiUrl, entryId)");
  });
});
