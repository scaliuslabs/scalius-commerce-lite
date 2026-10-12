// @vitest-environment node
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const virtualModules: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
let server: ViteDevServer;
let container: { renderToString(component: unknown, options: { props: object; request: Request }): Promise<string> };
let ProductSectionNav: unknown;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig({
    root,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom",
    plugins: [{
      name: "product-section-nav-test-modules",
      resolveId: (id: string) => id in virtualModules ? `\0section-nav-test:${id}` : undefined,
      load: (id: string) => id.startsWith("\0section-nav-test:") ? virtualModules[id.slice("\0section-nav-test:".length)] : undefined,
    }],
  } as never, { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never) as unknown as
    (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  const reactRenderer = (await server.ssrLoadModule("@astrojs/react/server.js")).default;
  container = await experimental_AstroContainer.create();
  (container as unknown as { addServerRenderer(renderer: object): void }).addServerRenderer({
    name: "@astrojs/react",
    renderer: reactRenderer,
  });
  ProductSectionNav = (await server.ssrLoadModule("/src/components/product/ProductSectionNav.astro")).default;
}, 120_000);

afterAll(async () => { await server?.close(); });

async function render(props: object) {
  const html = await container.renderToString(ProductSectionNav, {
    props,
    request: new Request("https://shop.test/products/sample"),
  });
  const document = new Window().document;
  document.write(`<body>${html}</body>`);
  return document;
}

describe("marketplace product section navigation", () => {
  it("links only to present sections and keeps native top and review anchors", async () => {
    const document = await render({ detailsId: "about", reviewsId: "reviews" });
    const nav = document.querySelector("[data-product-section-nav]");
    expect(nav?.hasAttribute("data-product-topbar")).toBe(true);
    expect(nav?.className).toContain("h-[52px]");
    expect([...nav!.querySelectorAll("a")].map((link) => [link.textContent?.trim(), link.getAttribute("href")]))
      .toEqual([["Top", "#product-container"], ["Details", "#about"], ["Reviews", "#reviews"]]);
    expect(nav?.querySelector('[data-section-anchor="about"]')?.getAttribute("aria-current")).toBe("location");
  });

  it("omits the bar when the product has no below-fold section", async () => {
    expect((await render({})).querySelector("[data-product-section-nav]")).toBeNull();
  });
});
