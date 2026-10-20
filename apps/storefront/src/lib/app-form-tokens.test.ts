import { describe, expect, it } from "vitest";
import { APP_FORM_TOKEN_PURPOSE, appFormToken } from "@scalius/shared/plugins/app-form";
import { sanitizePluginHtml } from "@scalius/shared/plugins/html";
import { deriveRuntimeSecret } from "@scalius/shared/runtime-secrets";
import { appOfFormAction, withAppFormTokens, type AppFormElement, type AppFormRewriter } from "./app-form-tokens";

const MASTER = "storefront-app-form-test-master-secret-0123456789abcdef";

/** A rewriter over a fixed list of forms (attributes), recording what it prepended. */
function fakeRewriter(forms: Array<Record<string, string>>, prepended: string[][]): () => AppFormRewriter {
  return () => {
    let handler: ((element: AppFormElement) => void | Promise<void>) | null = null;
    const rewriter: AppFormRewriter = {
      on(selector, handlers) {
        expect(selector).toBe("form");
        handler = handlers.element;
        return rewriter;
      },
      transform(response) {
        const done = forms.map(async (attributes, index) => {
          prepended[index] = [];
          await handler?.({ getAttribute: (name) => attributes[name] ?? null, prepend: (content) => void prepended[index]!.push(content) });
        });
        return new Response(Promise.all(done).then(() => "ok") as unknown as BodyInit, response);
      },
    };
    return rewriter;
  };
}

describe("the app form token", () => {
  it("names the app of a same-store proxy form, under any presence", () => {
    expect(appOfFormAction("/apps/scalius.sellers/portal/ship", "https://shop.test/apps/scalius.sellers/portal")).toBe("scalius.sellers");
    expect(appOfFormAction("/en-in/apps/scalius.sellers/apply", "https://shop.test/en-in/apps/scalius.sellers/apply")).toBe("scalius.sellers");
    expect(appOfFormAction(null, "https://shop.test/apps/acme.wishlist/wishlist")).toBe("acme.wishlist");
    expect(appOfFormAction("https://evil.test/apps/acme.wishlist/toggle", "https://shop.test/")).toBeNull();
    expect(appOfFormAction("/newsletter", "https://shop.test/")).toBeNull();
  });

  it("goes into a signed-in buyer's app POST forms only", async () => {
    const forms = [
      { method: "post", action: "/apps/acme.wishlist/toggle", "data-sx-form-app": "acme.wishlist" },
      { method: "get", action: "/apps/acme.wishlist/search", "data-sx-form-app": "acme.wishlist" },
      { method: "POST", action: "/newsletter", "data-sx-form-app": "acme.wishlist" },
    ];
    const prepended: string[][] = [];
    const html = new Response("<form></form>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
    const signedIn = new Request("https://shop.test/products/x", { headers: { Cookie: "a=1; cs_tok=buyer-session" } });
    await withAppFormTokens(signedIn, html, { SCALIUS_SECRET: MASTER }, fakeRewriter(forms, prepended)).text();
    const token = await appFormToken(await deriveRuntimeSecret(MASTER, APP_FORM_TOKEN_PURPOSE), "acme.wishlist", "buyer-session");
    expect(prepended).toEqual([[`<input type="hidden" name="_scalius_form" value="${token}">`], [], []]);

    // A guest's page (what the cache stores) and non-HTML answers are never touched.
    const guest = new Request("https://shop.test/products/x");
    const page = new Response("<form></form>", { headers: { "Content-Type": "text/html" } });
    expect(withAppFormTokens(guest, page, { SCALIUS_SECRET: MASTER }, () => { throw new Error("no rewrite"); })).toBe(page);
    const json = new Response("{}", { headers: { "Content-Type": "application/json" } });
    expect(withAppFormTokens(signedIn, json, { SCALIUS_SECRET: MASTER }, () => { throw new Error("no rewrite"); })).toBe(json);
  });

  it("goes only into forms the posting app drew itself, on every surface", async () => {
    // What the sanitizer makes of app A's product block and app B's own section and page.
    const blockOfA = sanitizePluginHtml(
      '<form method="post" action="/apps/b.loyalty/redeem" data-sx-form-app="b.loyalty"><input type="hidden" name="points" value="9999"><button type="submit">See sizes</button></form>',
      { pluginId: "a.sizes" },
    );
    const sectionOfB = sanitizePluginHtml('<form method="post" action="/apps/b.loyalty/redeem"><button type="submit">Redeem</button></form>', { pluginId: "b.loyalty" });
    const pageOfB = sanitizePluginHtml('<form method="post" action="/apps/b.loyalty/redeem"><button type="submit">Redeem</button></form>', { pluginId: "b.loyalty", formsTo: "/apps/b.loyalty/" });
    const ownersOf = (result: ReturnType<typeof sanitizePluginHtml>) => (result.ok ? [...result.html.matchAll(/data-sx-form-app="([^"]+)"/g)].map((match) => match[1]!) : []);
    // App A cannot claim B's form: its own stamp replaces anything it wrote.
    expect(ownersOf(blockOfA)).toEqual(["a.sizes"]);
    expect(ownersOf(sectionOfB)).toEqual(["b.loyalty"]);
    expect(ownersOf(pageOfB)).toEqual(["b.loyalty"]);
    const forms = [
      { method: "post", action: "/apps/b.loyalty/redeem", "data-sx-form-app": ownersOf(blockOfA)[0]! },
      { method: "post", action: "/apps/b.loyalty/redeem", "data-sx-form-app": ownersOf(sectionOfB)[0]! },
      { method: "post", action: "/apps/b.loyalty/redeem", "data-sx-form-app": ownersOf(pageOfB)[0]! },
      // A form no app drew (core markup) never gets an app's token either.
      { method: "post", action: "/apps/b.loyalty/redeem" },
    ];
    const prepended: string[][] = [];
    const html = new Response("<form></form>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
    const signedIn = new Request("https://shop.test/products/x", { headers: { Cookie: "cs_tok=buyer-session" } });
    await withAppFormTokens(signedIn, html, { SCALIUS_SECRET: MASTER }, fakeRewriter(forms, prepended)).text();
    const token = await appFormToken(await deriveRuntimeSecret(MASTER, APP_FORM_TOKEN_PURPOSE), "b.loyalty", "buyer-session");
    const field = `<input type="hidden" name="_scalius_form" value="${token}">`;
    expect(prepended).toEqual([[], [field], [field], []]);
  });
});
