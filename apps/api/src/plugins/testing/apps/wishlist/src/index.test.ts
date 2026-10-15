// The wishlist app over the SDK harness: the same runtime as the platform,
// and an in-memory bridge.
import { describe, expect, it } from "vitest";
import {
  createPluginTestHarness,
  parsePluginUiDocument,
  sanitizePluginHtml,
} from "@scalius/plugin-sdk/testing";
import wishlist from "./index";

const productApi = async (operationId: string, input: unknown) => {
  if (operationId === "dashboard.products.get_section") {
    const id = (input as { path: { id: string } }).path.id;
    const product = { name: id === "p_linen" ? "Linen Panjabi" : "Cotton Panjabi", slug: id === "p_linen" ? "linen-panjabi" : "cotton-panjabi", isActive: true, deletedAt: null };
    return { ok: true, status: 200, data: { section: "base", product }, error: null };
  }
  if (operationId === "dashboard.products.get_by_ids") {
    const id = (input as { query: { ids: string } }).query.ids;
    return { ok: true, status: 200, data: { products: [{ id, primaryImage: "https://cdn.example.com/linen.jpg" }] }, error: null };
  }
  return { ok: false, status: 404, data: null, error: { code: "x", message: "unknown" } };
};
const json = { accept: "application/json" };
const html = { accept: "text/html" };

describe("acme.wishlist", () => {
  it("asks guests to sign in, as JSON or as a page redirect", async () => {
    const harness = createPluginTestHarness(wishlist, { api: productApi });
    expect((await harness.route("public", "toggle", { method: "POST", headers: json, body: { productId: "p_linen" } })).value)
      .toEqual({ status: 401, body: { message: "Sign in to save products to your wishlist.", navigate: "/account" } });
    expect((await harness.route("public", "toggle", { method: "POST", headers: html, body: { productId: "p_linen" } })).value)
      .toEqual({ body: { redirect: "/account" } });
    expect(harness.records.get("wishes")?.size).toBe(0);
  });

  it("saves and removes a product for the signed-in buyer, keeping the wish count and product facts", async () => {
    const harness = createPluginTestHarness(wishlist, { api: productApi });
    const customer = { id: "cust_1" };
    expect((await harness.route("public", "toggle", { method: "POST", headers: json, body: { productId: "p_linen" }, customer })).value)
      .toEqual({ body: { pressed: true, message: "Saved to your wishlist." } });
    expect((await harness.route("public", "toggle", { method: "POST", headers: json, body: { productId: "p_linen" }, customer: { id: "cust_2" } })).value)
      .toMatchObject({ body: { pressed: true } });
    expect(harness.records.get("products")?.get("p_linen")).toEqual({
      product_id: "p_linen", name: "Linen Panjabi", slug: "linen-panjabi", image_url: "https://cdn.example.com/linen.jpg", available: true, wishes: 2,
    });
    expect((await harness.route("public", "state", { query: { productId: "p_linen" }, customer })).value).toEqual({ body: { pressed: true, signedIn: true } });
    expect((await harness.route("public", "state", { query: { productId: "p_linen" } })).value).toEqual({ body: { pressed: false, signedIn: false } });

    // Without JavaScript the form posts as a navigation: back to the product.
    expect((await harness.route("public", "toggle", { method: "POST", headers: html, body: { productId: "p_linen", returnTo: "/products/linen-panjabi" }, customer })).value)
      .toEqual({ body: { redirect: "/products/linen-panjabi" } });
    expect(harness.records.get("products")?.get("p_linen")).toMatchObject({ wishes: 1 });
    // Never an open redirect.
    expect((await harness.route("public", "toggle", { method: "POST", headers: html, body: { productId: "p_linen", returnTo: "//evil.com" }, customer })).value)
      .toEqual({ body: { redirect: "/apps/acme.wishlist/wishlist" } });
  });

  it("shows the buyer's wishlist page inside the store, and a sign-in page to guests", async () => {
    const harness = createPluginTestHarness(wishlist, { api: productApi });
    const customer = { id: "cust_1" };
    await harness.route("public", "toggle", { method: "POST", headers: json, body: { productId: "p_linen" }, customer });
    await harness.route("public", "toggle", { method: "POST", headers: json, body: { productId: "p_cotton" }, customer });
    const page = (await harness.route("public", "wishlist", { headers: html, customer })).value as { body: { page: { title: string; html: string } } };
    expect(page.body.page.title).toBe("Your wishlist");
    expect(page.body.page.html).toContain('href="/products/linen-panjabi"');
    expect(page.body.page.html).toContain("Cotton Panjabi");
    const clean = sanitizePluginHtml(page.body.page.html, { pluginId: "acme.wishlist", forms: true });
    expect(clean.ok).toBe(true);
    const guest = (await harness.route("public", "wishlist", { headers: html })).value as { body: { page: { html: string } } };
    expect(guest.body.page.html).toContain("Sign in to see your wishlist");
    const items = ((await harness.route("public", "wishlist", { headers: json, customer })).value as { body: { items: Array<{ productId: string }> } }).body.items;
    expect(items.map((item) => item.productId).sort()).toEqual(["p_cotton", "p_linen"]);
  });

  it("keeps wished products current from product events and ignores products nobody wished", async () => {
    let name = "Linen Panjabi";
    const harness = createPluginTestHarness(wishlist, {
      api: async (operationId, input) => {
        const result = await productApi(operationId, input);
        if (!result.ok || operationId !== "dashboard.products.get_section") return result;
        const data = result.data as { product: Record<string, unknown> };
        return { ...result, data: { ...data, product: { ...data.product, name } } };
      },
    });
    await harness.route("public", "toggle", { method: "POST", headers: json, body: { productId: "p_linen" }, customer: { id: "cust_1" } });
    name = "Linen Panjabi (Eid)";
    expect((await harness.event("product.updated", { type: "product", id: "p_linen" })).ok).toBe(true);
    expect(harness.records.get("products")?.get("p_linen")).toMatchObject({ name: "Linen Panjabi (Eid)" });
    expect((await harness.event("product.updated", { type: "product", id: "p_other" })).ok).toBe(true);
    expect(harness.records.get("products")?.has("p_other")).toBe(false);
    expect((await harness.event("product.deleted", { type: "product", id: "p_linen" }, { deletion: "trashed" })).ok).toBe(true);
    expect(harness.records.get("products")?.get("p_linen")).toMatchObject({ available: false });
  });

  it("ranks the most wished products for staff and shows a product's count on its card", async () => {
    const harness = createPluginTestHarness(wishlist, { api: productApi });
    await harness.route("public", "toggle", { method: "POST", headers: json, body: { productId: "p_linen" }, customer: { id: "c1" } });
    await harness.route("public", "toggle", { method: "POST", headers: json, body: { productId: "p_linen" }, customer: { id: "c2" } });
    await harness.route("public", "toggle", { method: "POST", headers: json, body: { productId: "p_cotton" }, customer: { id: "c1" } });
    const page = parsePluginUiDocument(((await harness.route("admin", "most-wished")).value as { body: unknown }).body);
    expect(page.ok).toBe(true);
    const text = JSON.stringify(page);
    expect(text.indexOf("Linen Panjabi")).toBeLessThan(text.indexOf("Cotton Panjabi"));
    const card = parsePluginUiDocument(((await harness.route("admin", "product-card", { query: { resource: "product", id: "p_linen" } })).value as { body: unknown }).body);
    expect(card).toMatchObject({ ok: true, document: { root: { children: [{ type: "stat", value: 2 }, expect.anything()] } } });
  });

  it("writes its dashboard screens in the staff member's dashboard language", async () => {
    const harness = createPluginTestHarness(wishlist, { api: productApi });
    await harness.route("public", "toggle", { method: "POST", headers: json, body: { productId: "p_linen" }, customer: { id: "c1" } });
    const bangla = { "accept-language": "bn" };
    const page = JSON.stringify(((await harness.route("admin", "most-wished", { headers: bangla })).value as { body: unknown }).body);
    expect(page).toContain("সবচেয়ে বেশি সেভ করা");
    expect(page).toContain("বিক্রি হচ্ছে");
    expect(page).not.toContain("Most wished");
    expect(page).not.toContain("On sale");
    const card = JSON.stringify(((await harness.route("admin", "product-card", { headers: bangla, query: { resource: "product", id: "p_linen" } })).value as { body: unknown }).body);
    expect(card).toContain("যত ক্রেতা সেভ করেছেন");
    // English without the header, and the manifest names the app in Bangla too.
    expect(JSON.stringify(((await harness.route("admin", "most-wished")).value as { body: unknown }).body)).toContain("Most wished");
    expect(wishlist.manifest.translations?.bn).toMatchObject({ name: "উইশলিস্ট", pages: { "most-wished": "সবচেয়ে বেশি সেভ করা" } });
  });
});
