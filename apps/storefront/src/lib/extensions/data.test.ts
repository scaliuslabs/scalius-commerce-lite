import { describe, expect, it } from "vitest";
import { pluginSettingsSchemaSchema } from "@scalius/shared/plugins/settings-schema";
import type { StorefrontExtension } from "@scalius/shared/plugins/storefront-components";
import type { HomepageHeaderLead } from "@/lib/homepage-sections";
import { headerPageData } from "./data";

const extension: StorefrontExtension = {
  pluginId: "acme.theme", version: "1.0.0", source: "bundled", release: "a".repeat(64),
  sections: ["hero"], skins: [], components: [], islands: [], stylesheet: false, connect: [],
  sectionSettings: { hero: pluginSettingsSchemaSchema.parse([
    { key: "heading", label: "Heading", type: "text", default: "Hello" },
    { key: "image", label: "Image", type: "image" },
    { key: "slides", label: "Slides", type: "list", fields: [{ key: "image", label: "Image", type: "image" }] },
    { key: "products", label: "Products", type: "products", default: "newest" },
    { key: "pick", label: "Product", type: "product" },
    { key: "link", label: "Link", type: "link" },
  ]) },
};
const lead: HomepageHeaderLead = {
  kind: "app", pluginId: "acme.theme", type: "hero", instanceId: "intro",
  values: { image: "photo", slides: [{ image: "photo" }, { image: "gone" }], pick: "prod_1", link: "javascript:alert(1)", unknown: "omit" },
  media: [{ id: "photo", url: "https://cdn.test/photo.jpg", alt: "Hero", width: 800, height: 600 }],
};

describe("header page data", () => {
  it("normalizes only the same app's settings, resolving media without carrying product data", () => {
    const result = headerPageData(lead, extension);
    expect(result.lead).toMatchObject({ kind: "app", pluginId: "acme.theme", type: "hero", instanceId: "intro" });
    expect(result.lead?.kind === "app" && result.lead.settings).toEqual({
      heading: "Hello",
      image: { url: "https://cdn.test/photo.jpg", srcset: null, width: 800, height: 600, alt: "Hero" },
      slides: [{ image: { url: "https://cdn.test/photo.jpg", srcset: null, width: 800, height: 600, alt: "Hero" } }, { image: null }],
      products: [], pick: null, link: null,
    });
  });

  it("shares an unrelated app's identity without its values, media or settings", () => {
    expect(headerPageData(lead, { ...extension, pluginId: "other.theme" })).toEqual({
      lead: { kind: "app", pluginId: "acme.theme", type: "hero", instanceId: "intro" },
    });
    expect(headerPageData(lead, { ...extension, sections: [] })).toEqual({
      lead: { kind: "app", pluginId: "acme.theme", type: "hero", instanceId: "intro" },
    });
  });

  it("preserves core and absent leads without inventing settings", () => {
    expect(headerPageData(null, extension)).toEqual({ lead: null });
    expect(headerPageData({ kind: "core", type: "seo-text" }, extension)).toEqual({ lead: { kind: "core", type: "seo-text" } });
  });

  it("shows a core lead's skin only to the app that owns it, with its values resolved", () => {
    const skinned: HomepageHeaderLead = { kind: "core", type: "hero", skin: { app: "acme.theme/big_hero", values: { layout: "split", ignored: 1 } } };
    const owner = {
      ...extension,
      skins: [{ id: "big_hero", target: "section:hero" as const, settings: pluginSettingsSchemaSchema.parse([{ key: "layout", label: "Layout", type: "text", default: "overlay" }]) }],
    };
    expect(headerPageData(skinned, owner)).toEqual({ lead: { kind: "core", type: "hero", skin: { id: "big_hero", settings: { layout: "split" } } } });
    expect(headerPageData(skinned, { ...owner, pluginId: "other.theme" })).toEqual({ lead: { kind: "core", type: "hero" } });
    expect(headerPageData(skinned, extension)).toEqual({ lead: { kind: "core", type: "hero" } });
  });
});
