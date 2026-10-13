// @vitest-environment node
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const modules: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
  [`${root}/src/lib/api/index.ts`]: `
    export const getProductBySlug = async () => ({ product: { name: 'Shirt', slug: 'shirt' }, variants: [] });
    export const getLayoutData = async () => null;
    export const getActiveCheckoutLanguage = async () => null;
    export const getCheckoutConfig = async () => ({ gateways: [{ id: 'cod' }] });
    export const getCities = async () => [{ id: 'dhaka', name: 'Dhaka' }];`,
  [`${root}/src/lib/checkout/order-form.ts`]: `
    export const ORDER_FORM_MAX_QUANTITY = 10;
    export const orderFormOptionName = () => null;
    export const orderFormOptions = () => [{ id: 'sku', label: 'Shirt', price: 100, cartItems: '{}' }];`,
  [`${root}/src/lib/checkout/quick-checkout.ts`]: 'export const QUICK_CHECKOUT_PATH = "/checkout/quick";',
};
let server: ViteDevServer;
let container: { renderToString(component: unknown, options: { props: object }): Promise<string> };
let AppComponent: unknown;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig({
    root, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom",
    plugins: [{ name: "checkout-embed-fixtures", enforce: "pre",
      resolveId: (id: string) => {
        const candidate = id === "@/lib/api" || id === `${root}/src/lib/api` ? `${root}/src/lib/api/index.ts`
          : id.startsWith("@/") ? `${root}/src/${id.slice(2)}.ts` : id;
        const resolved = candidate in modules ? candidate : `${candidate}.ts`;
        return resolved in modules ? `\0embed:${resolved}` : undefined;
      },
      load: (id: string) => id.startsWith("\0embed:") ? modules[id.slice(7)] : undefined,
    }],
  } as never, { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never) as unknown as
    (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  container = await experimental_AstroContainer.create();
  AppComponent = (await server.ssrLoadModule("/src/components/apps/AppComponent.astro")).default;
}, 120_000);
afterAll(async () => { await server?.close(); });

it("gives repeated same-product embeds distinct titles and location labels across placements", async () => {
  const props = { pluginId: "scalius.noor", base: "/_x/noor/release/", products: new Map([["prod_shirt", "shirt"]]),
    html: '<scalius-checkout data-product="prod_shirt"></scalius-checkout>'.repeat(2) };
  const html = (await container.renderToString(AppComponent, { props: { ...props, instanceId: "first" } }))
    + (await container.renderToString(AppComponent, { props: { ...props, instanceId: "second" } }));
  const document = new Window().document;
  document.body.innerHTML = html;
  const forms = [...document.querySelectorAll("form[data-order-form]")];
  expect(forms).toHaveLength(4);
  const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const form of forms) {
    expect(form.querySelector("h2")!.id).toBe(form.getAttribute("aria-labelledby"));
    for (const label of form.querySelectorAll("label[for]")) {
      const control = document.getElementById(label.getAttribute("for")!);
      expect(control).not.toBeNull();
      expect(control && form.contains(control)).toBe(true);
    }
  }
});

it("orders only a product the component was given: an embed naming any other renders nothing", async () => {
  const html = await container.renderToString(AppComponent, { props: {
    pluginId: "scalius.noor", base: "/_x/noor/release/", products: new Map([["prod_shirt", "shirt"]]),
    html: '<p>a</p><scalius-checkout data-product="prod_other"></scalius-checkout>',
  } });
  expect(html).toContain("<p>a</p>");
  expect(html).not.toContain("data-order-form");
});
