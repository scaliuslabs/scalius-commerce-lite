import { describe, expect, it } from "vitest";
import {
  STOREFRONT_SECTION_REGISTRY,
  STOREFRONT_SECTION_TYPES,
  storefrontSectionDefault,
} from "@scalius/shared/storefront-theme";
import { themeSettingMessages } from "~/i18n/theme-settings";
import { describeSetting, settingDefault, switchVariant, type VariantsSpec } from "./introspect";
import { labelRequirements, settingLabelKey } from "./labels";
import { registryForms, sectionSettingSpec } from "./registry-forms";

describe("theme setting labels", () => {
  it("names every registry setting, choice and list item in English and Bangla", () => {
    const missing: string[] = [];
    const forms = registryForms();
    // Every section type and every block variant with settings is a form.
    expect(forms.filter((form) => form.id.startsWith("section:"))).toHaveLength(STOREFRONT_SECTION_TYPES.length);
    expect(forms.some((form) => form.id === "block:footer:directory")).toBe(true);
    for (const form of forms) {
      for (const requirement of labelRequirements(form.spec)) {
        const key = settingLabelKey(form.scope, requirement.path, requirement.suffix);
        if (!key) {
          missing.push(`${form.id} ${requirement.path}${requirement.suffix ? ` (${requirement.suffix})` : ""}`);
          continue;
        }
        expect(themeSettingMessages.en[key].trim()).not.toBe("");
        expect(themeSettingMessages.bn[key].trim()).not.toBe("");
      }
    }
    expect(missing).toEqual([]);
  });

  it("reads the most specific label first, then the shared one", () => {
    expect(settingLabelKey(["s.category-tiles"], "title")).toBe("s.category-tiles.title");
    expect(settingLabelKey(["s.product-rail"], "title")).toBe("f.title");
    expect(settingLabelKey(["b.card.standard", "b.card"], "facts")).toBe("b.card.facts");
    expect(settingLabelKey(["b.card.standard", "b.card"], "action", "quick-add")).toBe("b.card.action.quick-add");
    expect(settingLabelKey(["b.buyBox.fashion", "b.buyBox"], "showBuyNow")).toBe("b.buyBox.showBuyNow");
    expect(settingLabelKey(["s.product-tabs"], "tabs.source.kind", "on-sale")).toBe("f.source.kind.on-sale");
    expect(settingLabelKey(["s.hero"], "nothing.here")).toBeNull();
  });
});

describe("registry introspection", () => {
  it("draws every section type: a default section of each type is valid", () => {
    for (const type of STOREFRONT_SECTION_TYPES) {
      expect(() => sectionSettingSpec(type)).not.toThrow();
      const section = storefrontSectionDefault(type, "probe");
      expect(STOREFRONT_SECTION_REGISTRY[type].schema.safeParse(section).success).toBe(true);
    }
  });

  it("reads limits, choices, lists and variants from the schema", () => {
    const hero = sectionSettingSpec("hero");
    expect(hero.kind).toBe("object");
    if (hero.kind !== "object") return;
    const field = (key: string) => hero.fields.find((each) => each.key === key)!.spec;
    expect(field("layout")).toMatchObject({ kind: "choice", values: expect.arrayContaining(["split", "full-bleed"]) });
    expect(field("slides")).toMatchObject({ kind: "list", max: 10, min: 0 });
    expect(field("phonePlacement")).toMatchObject({ kind: "choice", optional: true, values: ["after-categories"] });
    const rail = sectionSettingSpec("product-rail");
    if (rail.kind !== "object") throw new Error("object");
    expect(rail.fields.find((each) => each.key === "limit")!.spec).toEqual({ kind: "number", min: 4, max: 24, int: true });
    expect(rail.fields.find((each) => each.key === "title")!.spec).toEqual({ kind: "text", min: 0, max: 80 });
    expect(rail.fields.find((each) => each.key === "source")!.spec).toMatchObject({ kind: "variants", key: "kind" });
    expect(sectionSettingSpec("endless-grid")).toMatchObject({ fields: [expect.anything(), { key: "pageSize", spec: { kind: "choice", values: [12, 24, 36] } }] });
  });

  it("switches a variant keeping the settings both declare", () => {
    const editorial = sectionSettingSpec("editorial") as VariantsSpec;
    const next = switchVariant(editorial, { layout: "rich-text", heading: "Our story", body: "Since 1998" }, "image-with-text");
    expect(next).toEqual({ layout: "image-with-text", heading: "Our story", body: "Since 1998", mediaId: null, imageSide: "start" });
    expect(STOREFRONT_SECTION_REGISTRY.editorial.settings.safeParse(next).success).toBe(true);
    expect(switchVariant(editorial, next, "testimonial")).toEqual({ layout: "testimonial", quotes: [] });
  });

  it("starts a list at its minimum length", () => {
    const tabs = describeSetting(STOREFRONT_SECTION_REGISTRY["product-tabs"].settings);
    if (tabs.kind !== "object") throw new Error("object");
    const list = tabs.fields.find((each) => each.key === "tabs")!.spec;
    expect(settingDefault(list)).toEqual([
      { label: "", source: { kind: "newest" } },
      { label: "", source: { kind: "newest" } },
    ]);
  });
});
