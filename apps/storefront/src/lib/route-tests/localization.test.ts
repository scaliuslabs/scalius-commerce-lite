// @vitest-environment node
/**
 * The market selector's POST (Shopify's /localization): an explicit choice
 * saved in the `localization` cookie, then the same page under the chosen
 * market's presence. Works without JavaScript, refuses cross-site posts and
 * never redirects outside the store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getLayoutData: vi.fn() }));
vi.mock("@/lib/api/storefront", () => ({ getLayoutData: mocks.getLayoutData }));

import { GET, POST } from "../../pages/localization";
import { safeReturnPath } from "../market-selector";

const MATRIX = { markets: [
  { id: "mkt_backup", handle: "bangladesh", name: "Bangladesh", isBackup: true, countries: ["BD"], presences: [{ value: "", locale: "bn" }] },
  { id: "mkt_in", handle: "india", name: "India", isBackup: false, countries: ["IN", "NP"], presences: [{ value: "en-in", locale: "en" }] },
] };

function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const request = new Request("https://shop.example/localization", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
  return POST({ request, url: new URL(request.url) } as never) as Promise<Response>;
}

describe("POST /localization", () => {
  beforeEach(() => {
    mocks.getLayoutData.mockReset();
    mocks.getLayoutData.mockResolvedValue({ markets: MATRIX });
  });

  it("saves the choice and returns to the same page under the chosen presence", async () => {
    const india = await post({ country_code: "np", return_to: "/products/tee?size=M" });
    expect(india.status).toBe(303);
    expect(india.headers.get("Location")).toBe("/en-in/products/tee?size=M");
    expect(india.headers.get("Set-Cookie")).toBe("localization=NP%3Aen-in; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
    expect(india.headers.get("Cache-Control")).toContain("no-store");

    const back = await post({ country_code: "BD", return_to: "/en-in/cart" });
    expect(back.headers.get("Location")).toBe("/cart");
    expect(back.headers.get("Set-Cookie")).toContain("localization=BD%3A;");
    // A country no market sells to is the backup market's.
    const elsewhere = await post({ country_code: "US", return_to: "/en-in" });
    expect(elsewhere.headers.get("Location")).toBe("/");
    expect(elsewhere.headers.get("Set-Cookie")).toContain("localization=US%3A;");
  });

  it("never leaves the store and saves nothing it cannot resolve", async () => {
    for (const returnTo of ["https://evil.example/x", "//evil.example/x", "/api/checkout/create-order", "javascript:alert(1)"]) {
      expect((await post({ country_code: "IN", return_to: returnTo })).headers.get("Location"), returnTo).toBe("/en-in");
    }
    const unknown = await post({ country_code: "ZZZ", return_to: "/cart" });
    expect(unknown.headers.get("Location")).toBe("/cart");
    expect(unknown.headers.get("Set-Cookie")).toBeNull();
    mocks.getLayoutData.mockResolvedValueOnce(null);
    expect((await post({ country_code: "IN", return_to: "/cart" })).headers.get("Set-Cookie")).toBeNull();
  });

  it("takes the language form's choice: the page's market in that language (`/en`, Shopify's language subfolder)", async () => {
    mocks.getLayoutData.mockResolvedValue({ markets: { markets: [
      { ...MATRIX.markets[0]!, presences: [{ value: "", locale: "bn" }, { value: "en", locale: "en" }] },
      MATRIX.markets[1]!,
    ] } });
    const english = await post({ country_code: "BD", locale_code: "en", return_to: "/products/tee" });
    expect(english.headers.get("Location")).toBe("/en/products/tee");
    expect(english.headers.get("Set-Cookie")).toContain("localization=BD%3Aen;");
    const bangla = await post({ country_code: "BD", locale_code: "bn", return_to: "/en/products/tee" });
    expect(bangla.headers.get("Location")).toBe("/products/tee");
    // A language the market does not serve leaves the buyer on its own URL.
    const french = await post({ country_code: "BD", locale_code: "fr", return_to: "/cart" });
    expect(french.headers.get("Location")).toBe("/cart");
  });

  it("refuses a cross-site post and answers GET with 405", async () => {
    const forged = await post({ country_code: "IN", return_to: "/" }, { Origin: "https://evil.example", Cookie: "cs_auth=1" });
    expect(forged.status).toBe(403);
    expect((await (GET as () => Response)()).status).toBe(405);
    expect(safeReturnPath("/en-in/pages/about?x=1")).toBe("/pages/about?x=1");
  });
});
