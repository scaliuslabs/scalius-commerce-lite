import { describe, expect, it } from "vitest";
import { parsePluginManifest, pluginGrantAdditions, pluginGrantExpands, pluginGrantKey, pluginGrantRequest, type PluginManifestInput } from "./manifest";
import {
  readStorefrontExtensions,
  resolveStorefrontSettings,
  sealedStorefrontDigests,
  storefrontFileContentType,
  storefrontSettingNeeds,
} from "./storefront-components";
import { parseStorefrontExtensionPath, storefrontExtensionBase } from "./storefront-protocol";
import { pluginSettingsSchemaSchema } from "./settings-schema";

const schema = pluginSettingsSchemaSchema.parse([
  { key: "heading", label: "Heading", type: "text", default: "Hi" },
  { key: "image", label: "Image", type: "image" },
  { key: "products", label: "Products", type: "products", default: "newest", limit: 4 },
  { key: "more", label: "More", type: "products", limit: 12 },
  { key: "pick", label: "Pick", type: "product" },
  { key: "link", label: "Link", type: "link" },
  { key: "slides", label: "Slides", type: "list", fields: [
    { key: "image", label: "Image", type: "image", required: true },
    { key: "title", label: "Title", type: "text" },
  ] },
]);

const base: PluginManifestInput = {
  id: "acme.theme", name: "Theme", version: "1.0.0", apiVersion: "2026-10", description: "A theme.", author: { name: "Acme" },
};

describe("storefront settings", () => {
  it("names the images and product lists a placement needs, once each", () => {
    expect(storefrontSettingNeeds(schema, {
      image: "media_a", more: "newest", pick: "prod_9",
      slides: [{ image: "media_b", title: "One" }, { image: "media_a" }],
    })).toEqual({
      mediaIds: ["media_a", "media_b"],
      products: [{ source: "newest", limit: 12 }, { source: "product:prod_9", limit: 1 }],
    });
  });

  it("resolves images, products, picks, links and list items; drops what no longer validates", () => {
    const card = { id: "p", title: "P" } as never;
    const settings = resolveStorefrontSettings(schema, {
      image: "media_a", link: "javascript:x", pick: "prod_9", slides: [{ image: "media_gone", title: "One" }], unknown: 1,
    }, {
      image: (id) => (id === "media_a" ? { url: "https://m/a", srcset: null, width: 1, height: 1, alt: "" } : null),
      products: (source) => (source === "newest" || source === "product:prod_9" ? [card, card, card, card, card] : []),
    });
    expect(settings.heading).toBe("Hi");
    expect(settings.image).toEqual({ url: "https://m/a", srcset: null, width: 1, height: 1, alt: "" });
    expect(settings.products).toHaveLength(4);
    expect(settings.more).toEqual([]);
    expect(settings.pick).toBe(card);
    expect(settings.link).toBeNull();
    expect(settings.slides).toEqual([{ image: null, title: "One" }]);
    expect("unknown" in settings).toBe(false);
  });
});

describe("storefront manifest", () => {
  it("accepts component sections and blocks, skins, templates and islands", () => {
    const parsed = parsePluginManifest({
      ...base,
      storefront: {
        sections: [{ type: "hero", name: "Hero", settings: [{ key: "image", label: "Image", type: "image" }] }],
        productBlocks: [{ type: "size-guide", name: "Size guide", placement: "below" }],
        skins: [
          { id: "head", target: "header", name: "Header" },
          { id: "pdp", target: "product-main", name: "Product page" },
          { id: "hero", target: "section:hero", name: "Hero" },
        ],
        templates: [{ id: "look", name: "Look", theme: { apps: { skins: { header: { app: "acme.theme/head", values: {} } } }, sections: [
          { id: "hero", type: "hero", version: 1, settings: { layout: "full-bleed", slides: [] }, skin: { app: "acme.theme/hero", values: {} } },
        ] } }],
        islands: [{ name: "carousel" }],
        stylesheet: true,
        connect: ["api.acme.test"],
      },
    });
    expect(parsed.ok).toBe(true);
  });

  it("keeps storefront types out of skins, blocks and the app's settings", () => {
    const issues = (input: Partial<PluginManifestInput>) => {
      const parsed = parsePluginManifest({ ...base, ...input });
      return parsed.ok ? [] : parsed.issues.map((issue) => issue.message);
    };
    expect(issues({ storefront: { skins: [{ id: "card", target: "product-card", name: "Card", settings: [{ key: "p", label: "P", type: "products" }] }] } }).join()).toMatch(/skin's settings cannot name images or products/);
    expect(issues({ storefront: { productBlocks: [{ type: "b", name: "B", placement: "below", settings: [{ key: "i", label: "I", type: "image" }] }] } }).join()).toMatch(/product block's settings cannot name images/);
    expect(issues({ storefront: { skins: [{ id: "x", target: "section:recently-viewed", name: "X" }] } }).join()).toMatch(/section:<core section type>/);
    expect(issues({ storefront: { skins: [{ id: "x", target: "sidebar", name: "X" }] } }).join()).toMatch(/section:<core section type>/);
    expect(issues({ storefront: { skins: [{ id: "x", target: "header", name: "X" }, { id: "x", target: "footer", name: "Y" }] } }).join()).toMatch(/Skin ids must be unique/);
    expect(issues({ settings: [{ key: "i", label: "I", type: "image" }] }).join()).toMatch(/storefront components/);
    expect(issues({ storefront: { sections: [{ type: "a", name: "A", route: "draw" } as never] } }).join()).toMatch(/Unrecognized key/);
  });

  it("asks a Super Admin again when an update starts running storefront code or reaching new hosts", () => {
    const parse = (storefront: PluginManifestInput["storefront"]) => {
      const parsed = parsePluginManifest({ ...base, storefront });
      if (!parsed.ok) throw new Error("invalid");
      return pluginGrantRequest(parsed.manifest);
    };
    const before = parse({ sections: [] });
    // Grants of apps without components keep their key (a default dimension is left out).
    expect(before.storefrontCode).toBe(false);
    expect(pluginGrantKey(before)).not.toContain("storefrontCode");
    const after = parse({ sections: [{ type: "a", name: "A" }], connect: ["api.acme.test"] });
    expect(pluginGrantExpands(before, after)).toBe(true);
    expect(pluginGrantAdditions(before, after)).toMatchObject({ storefrontCode: true, storefrontConnect: ["api.acme.test"] });
    expect(pluginGrantExpands(after, parse({ sections: [{ type: "a", name: "A" }], connect: ["api.acme.test"] }))).toBe(false);
  });
});

describe("storefront files", () => {
  it("names each file's type, and nothing outside the layout", () => {
    expect(storefrontFileContentType("storefront.js")).toMatch(/javascript/);
    expect(storefrontFileContentType("islands/carousel.js")).toMatch(/javascript/);
    expect(storefrontFileContentType("public/fonts/a.woff2")).toBe("font/woff2");
    expect(storefrontFileContentType("public/../x.woff2")).toBeNull();
    expect(storefrontFileContentType("public/a.html")).toBeNull();
    expect(storefrontFileContentType("other.js")).toBeNull();
  });

  it("reads the digests sealed into a bundle", () => {
    const digest = "a".repeat(64);
    const code = `export default 1;\n//# scalius-assets {"assets/icon.svg":"${"b".repeat(64)}"}\n//# scalius-storefront {"storefront.js":"${digest}","../x":"${digest}"}\n`;
    expect(sealedStorefrontDigests(code)).toEqual({ "storefront.js": digest });
    expect(sealedStorefrontDigests("export default 1;")).toEqual({});
  });

  it("serves a release's files under one immutable base", () => {
    const release = "c".repeat(64);
    expect(storefrontExtensionBase("acme.theme", release)).toBe(`/_x/acme.theme/${release}/`);
    expect(parseStorefrontExtensionPath(`/_x/acme.theme/${release}/public/fonts/a.woff2`)).toEqual({ pluginId: "acme.theme", release, path: "public/fonts/a.woff2" });
    expect(parseStorefrontExtensionPath(`/_x/acme.theme/${release}/secret.txt`)).toBeNull();
    expect(parseStorefrontExtensionPath(`/_x/acme.theme/short/storefront.js`)).toBeNull();
  });

  it("reads the layout's extensions, leaving malformed ones out", () => {
    const release = "d".repeat(64);
    expect(readStorefrontExtensions([
      { pluginId: "acme.theme", version: "1.0.0", source: "upload", release, sections: ["hero", "BAD"], sectionSettings: { hero: [{ key: "a", label: "A", type: "text" }] }, skins: [{ id: "head", target: "header", settings: [] }, { id: "x", target: "nope", settings: [] }, { id: "hero", target: "section:hero", settings: [] }], blocks: [{ type: "guide", target: "product.below", settings: [] }, { type: "bad", target: "product.top", settings: [] }], islands: ["carousel"], stylesheet: true, connect: ["api.acme.test", "javascript:"] },
      { pluginId: "acme.bad", version: "1", source: "upload", release: "nope" },
      "junk",
    ])).toEqual([{
      pluginId: "acme.theme", version: "1.0.0", source: "upload", release,
      sections: ["hero"], sectionSettings: { hero: [{ key: "a", label: "A", type: "text", required: false, maxLength: 200 }] },
      skins: [{ id: "head", target: "header", settings: [] }, { id: "hero", target: "section:hero", settings: [] }],
      blocks: [{ type: "guide", target: "product.below", settings: [] }],
      islands: ["carousel"], stylesheet: true, connect: ["api.acme.test"],
    }]);
  });
});
