// @vitest-environment node
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import type { ViteDevServer } from "vite";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { pickWarrantyCopy, warrantyClaimFlagText, type WarrantyClaimFlag } from "@/lib/account-warranties";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};

interface Container {
  renderToString(component: unknown, options: { props?: object; request?: Request }): Promise<string>;
}

let server: ViteDevServer;
let container: Container;
let WarrantyClaimForm: unknown;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig(
    {
      root,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
      plugins: [
        {
          name: "warranty-render-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0warranty-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0warranty-test:") ? VIRTUAL_MODULES[id.slice("\0warranty-test:".length)] : undefined,
        },
      ],
    } as never,
    { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never,
  ) as unknown as (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  container = await experimental_AstroContainer.create();
  WarrantyClaimForm = (await server.ssrLoadModule("/src/components/warranty/WarrantyClaimForm.astro")).default;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const window = new Window();
const copy = pickWarrantyCopy(ENGLISH_CHECKOUT_LANGUAGE_DATA, ENGLISH_CHECKOUT_LANGUAGE_DATA);

describe("refused warranty claim without JavaScript", () => {
  it.each(["exists", "inactive", "unavailable"] satisfies WarrantyClaimFlag[])("shows %s even after the warranty becomes ineligible", async (flag) => {
    for (const access of [{ kind: "account" }, { kind: "receipt", orderId: "ord_1" }]) {
      const html = await container.renderToString(WarrantyClaimForm, {
        props: { warrantyId: "wty_abcdefgh1234", access, copy, returnTo: "/account/warranties", canClaim: false, flag },
      });
      const doc = new window.DOMParser().parseFromString(html, "text/html");
      expect(doc.querySelector('[role="status"]')?.textContent).toBe(warrantyClaimFlagText(flag, copy));
      expect(doc.querySelector("form, details")).toBeNull();
    }
  });

  it("keeps an eligible refused form open with its message", async () => {
    const html = await container.renderToString(WarrantyClaimForm, {
      props: { warrantyId: "wty_abcdefgh1234", access: { kind: "account" }, copy, returnTo: "/account/warranties", canClaim: true, flag: "photo" },
    });
    const doc = new window.DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("details[open] form[method=post]")).not.toBeNull();
    expect(doc.body.textContent).toContain(copy.warrantyClaimPhotoText);
  });

  it("does not render a form or notice for an ineligible warranty without a refusal", async () => {
    const html = await container.renderToString(WarrantyClaimForm, {
      props: { warrantyId: "wty_abcdefgh1234", access: { kind: "account" }, copy, returnTo: "/account/warranties", canClaim: false },
    });
    const doc = new window.DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector('form, details, [role="status"]')).toBeNull();
  });
});
