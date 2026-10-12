import { describe, expect, it } from "vitest";
import {
  pluginSettingsSchemaSchema,
  resolvePluginSettingValues,
  validatePluginSettingValues,
  type PluginSettingField,
} from "@scalius/shared/plugins/settings-schema";
import type { ThemeAppSettingField } from "~/lib/api-query-options/online-store";
import {
  appFieldValue,
  appListItemDefaults,
  appListItemProblems,
  appSettingDefaults,
  appSettingProblem,
  appSettingProblems,
  appValuesInvalid,
  themeAppFields,
  withAppSettingValue,
} from "./app-settings";

/** A manifest field as the theme workspace sends it (apps/api/src/schemas/app-settings.ts). */
function workspaceField(field: PluginSettingField): ThemeAppSettingField {
  const options = field.type === "select" || field.type === "multiselect" ? field.options : null;
  return {
    ...(field.type === "products" ? { limit: field.limit } : {}),
    ...(field.type === "list" ? { fields: field.fields.map((item) => workspaceField(item)), ...(field.itemLabel ? { itemLabel: field.itemLabel } : {}) } : {}),
    key: field.key,
    label: field.label,
    help: field.help ?? null,
    type: field.type,
    required: field.required,
    options: options ? options.map((option) => ({ value: option.value, label: option.label })) : null,
    default: field.type !== "secret" && "default" in field && field.default !== undefined ? field.default : null,
    min: field.type === "number" || field.type === "list" ? field.min ?? null : null,
    max: field.type === "number" || field.type === "list" ? field.max ?? null : null,
    integer: field.type === "number" ? field.integer : false,
    maxLength: field.type === "text" || field.type === "textarea" ? field.maxLength : null,
  };
}

const MANIFEST = pluginSettingsSchemaSchema.parse([
  { key: "heading", label: "Heading", type: "text", maxLength: 40, default: "What buyers say" },
  { key: "intro", label: "Intro", type: "textarea", required: true },
  { key: "count", label: "Reviews shown", type: "number", min: 1, max: 12, integer: true, default: 4 },
  { key: "ratio", label: "Ratio", type: "number" },
  { key: "stars", label: "Show stars", type: "boolean", default: true },
  {
    key: "layout",
    label: "Layout",
    type: "select",
    options: [{ value: "grid", label: "Grid" }, { value: "carousel", label: "Carousel" }],
    default: "grid",
  },
  {
    key: "sources",
    label: "Sources",
    type: "multiselect",
    required: true,
    options: [{ value: "google", label: "Google" }, { value: "store", label: "This store" }],
    default: ["store"],
  },
  { key: "more", label: "More reviews", type: "url" },
  { key: "contact", label: "Contact", type: "email" },
  { key: "accent", label: "Accent", type: "color", default: "#1a7f37" },
  { key: "api_key", label: "API key", type: "secret" },
]);
const FIELDS = MANIFEST.map(workspaceField);
const field = (key: string) => FIELDS.find((each) => each.key === key)!;
const manifest = (key: string) => MANIFEST.find((each) => each.key === key)!;

describe("app setting values", () => {
  it("starts a placement at the app's defaults, never a secret", () => {
    expect(themeAppFields(FIELDS).map((each) => each.key)).not.toContain("api_key");
    expect(appSettingDefaults(FIELDS)).toEqual({
      heading: "What buyers say",
      count: 4,
      stars: true,
      layout: "grid",
      sources: ["store"],
      accent: "#1a7f37",
    });
    // The shared resolver fills the same values for an empty placement.
    expect(appSettingDefaults(FIELDS)).toEqual(resolvePluginSettingValues(MANIFEST, {}));
  });

  it("shows the stored value, the default for a key never set, and nothing for a cleared one", () => {
    expect(appFieldValue(field("count"), { count: 8 })).toBe(8);
    expect(appFieldValue(field("count"), {})).toBe(4);
    expect(appFieldValue(field("count"), { count: null })).toBeNull();
    expect(appFieldValue(field("more"), {})).toBeUndefined();
  });

  it("keeps the app's keys when a setting changes: unknown ones go, untouched ones stay unset", () => {
    const values = { heading: "Reviews", gone: "old", count: 6 };
    expect(withAppSettingValue(FIELDS, values, "count", 8)).toEqual({ heading: "Reviews", count: 8 });
    // Back to the app's default.
    expect(withAppSettingValue(FIELDS, values, "heading", undefined)).toEqual({ count: 6 });
    expect(withAppSettingValue(FIELDS, {}, "more", "https://reviews.test")).toEqual({ more: "https://reviews.test" });
  });

  it("says what each kind of setting refuses", () => {
    const cases: Array<[string, unknown, string | null]> = [
      ["heading", "x".repeat(41), "tooLong"],
      ["heading", "Reviews", null],
      ["intro", "", "required"],
      ["intro", null, "required"],
      ["count", 4.5, "wholeNumber"],
      ["count", 0, "atLeast"],
      ["count", 13, "atMost"],
      ["count", "4", "number"],
      ["ratio", 1.5, null],
      ["stars", "yes", "invalid"],
      ["layout", "list", "option"],
      ["layout", "carousel", null],
      ["sources", ["google", "facebook"], "option"],
      ["sources", [], "required"],
      ["more", "http://reviews.test", "https"],
      ["more", "https:reviews.test", "https"],
      ["more", "reviews.test", "https"],
      ["more", "https://reviews.test/all", null],
      ["more", null, null],
      ["contact", "help@shop", "email"],
      ["contact", "help@shop.test", null],
      ["accent", "#1A7F37", "color"],
      ["accent", "green", "color"],
      ["accent", "#0a0b0c", null],
    ];
    for (const [key, value, kind] of cases) {
      expect([key, value, appSettingProblem(field(key), value)?.kind ?? null]).toEqual([key, value, kind]);
    }
    expect(appSettingProblem(field("heading"), "x".repeat(41))).toEqual({ kind: "tooLong", max: 40 });
    expect(appSettingProblem(field("count"), 0)).toEqual({ kind: "atLeast", min: 1 });
  });

  it("agrees with the plugin settings validator on every stored value", () => {
    const values: Array<[string, unknown]> = [
      ["heading", "x".repeat(41)], ["heading", ""], ["intro", ""], ["intro", "Hello"], ["intro", null],
      ["count", 4.5], ["count", 0], ["count", 12], ["count", "4"], ["ratio", -3.25],
      ["stars", false], ["stars", "yes"], ["layout", "list"], ["layout", "grid"],
      ["sources", ["google", "facebook"]], ["sources", ["google", "store"]],
      ["more", "http://reviews.test"], ["more", "https:reviews.test"], ["more", "https://reviews.test"], ["more", ""],
      ["contact", "help@shop"], ["contact", "a b@shop.test"], ["contact", "help@shop.test"],
      ["accent", "#1A7F37"], ["accent", "#1a7f37"], ["accent", null],
    ];
    for (const [key, value] of values) {
      const shared = validatePluginSettingValues([manifest(key)], { [key]: value }).ok;
      expect([key, value, appSettingProblem(field(key), value) === null]).toEqual([key, value, shared]);
    }
    // The one deliberate difference: nothing chosen in a required multi-choice is nothing set.
    expect(validatePluginSettingValues([manifest("sources")], { sources: [] }).ok).toBe(true);
    expect(appSettingProblem(field("sources"), [])).toEqual({ kind: "required" });
  });

  it("judges what the store renders: a key never set counts as its default", () => {
    const fresh = appSettingDefaults(FIELDS);
    // The required intro has no default.
    expect([...appSettingProblems(FIELDS, fresh).keys()]).toEqual(["intro"]);
    expect(appValuesInvalid(FIELDS, { ...fresh, intro: "Loved by 2,000 buyers" })).toBe(false);
    // A value of the wrong type (the app changed the setting) needs setting again.
    expect(appSettingProblems(FIELDS, { intro: "Hi", count: "many" }).get("count")).toEqual({ kind: "number" });
  });
});

describe("storefront component settings", () => {
  const COMPONENT = pluginSettingsSchemaSchema.parse([
    { key: "photo", label: "Photo", type: "image", required: true },
    { key: "featured", label: "Featured product", type: "product" },
    { key: "shelf", label: "Products", type: "products", limit: 6, default: "newest" },
    { key: "cta", label: "Button link", type: "link", default: "/collections/all" },
    {
      key: "slides",
      label: "Slides",
      type: "list",
      itemLabel: "Slide",
      min: 1,
      max: 3,
      fields: [
        { key: "title", label: "Title", type: "text", required: true, maxLength: 40 },
        { key: "image", label: "Image", type: "image" },
        { key: "link", label: "Link", type: "link" },
        { key: "dark", label: "Dark text", type: "boolean", default: true },
      ],
    },
  ]);
  const fields = COMPONENT.map(workspaceField);
  const component = (key: string) => fields.find((each) => each.key === key)!;
  const slides = component("slides");

  it("starts a new list item at its fields' defaults", () => {
    expect(appListItemDefaults(slides)).toEqual({ dark: true });
    expect(appSettingDefaults(fields)).toEqual({ shelf: "newest", cta: "/collections/all" });
  });

  it("says what images, products, links and lists refuse", () => {
    const cases: Array<[string, unknown, string | null]> = [
      ["photo", null, "required"],
      ["photo", "media_1", null],
      ["photo", "media 1", "invalid"],
      ["featured", "prod_9", null],
      ["featured", "prod/9", "invalid"],
      ["featured", null, null],
      ["shelf", "collection:", "products"],
      ["shelf", "category:", "products"],
      ["shelf", "collection:col_1", null],
      ["shelf", "popular", null],
      ["shelf", "trending", "invalid"],
      ["cta", "/pages/about", null],
      ["cta", "https://shop.test/sale", null],
      ["cta", "//evil.test", "link"],
      ["cta", "http://shop.test", "link"],
      ["cta", "pages/about", "link"],
      ["slides", [], "fewItems"],
      ["slides", [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }], "manyItems"],
      ["slides", [{ title: "Eid sale", dark: false }], null],
      ["slides", [{ title: "" }], "items"],
      ["slides", [{ title: "Eid", link: "nope" }], "items"],
      ["slides", [{ title: "Eid", gone: "x" }], "invalid"],
      ["slides", ["Eid"], "invalid"],
    ];
    for (const [key, value, kind] of cases) {
      expect([key, value, appSettingProblem(component(key), value)?.kind ?? null]).toEqual([key, value, kind]);
    }
    expect(appSettingProblem(component("shelf"), "category:")).toEqual({ kind: "products", source: "category" });
    expect(appSettingProblem(slides, [])).toEqual({ kind: "fewItems", min: 1 });
    expect([...appListItemProblems(slides, { title: "x".repeat(41), link: "nope" })]).toEqual([
      ["title", { kind: "tooLong", max: 40 }],
      ["link", { kind: "link" }],
    ]);
  });

  it("agrees with the plugin settings validator on every stored value", () => {
    const values: Array<[string, unknown]> = [
      ["photo", "media_1"], ["photo", "media 1"], ["photo", ""],
      ["featured", "prod_9"], ["featured", "prod/9"],
      ["shelf", "collection:"], ["shelf", "collection:col_1"], ["shelf", "on-sale"], ["shelf", "trending"],
      ["cta", "/pages/about"], ["cta", "//evil.test"], ["cta", "https://shop.test"], ["cta", "http://shop.test"], ["cta", `/${"a".repeat(2048)}`],
      ["slides", []], ["slides", [{ title: "A" }]], ["slides", [{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }]],
      ["slides", [{ title: "A", image: "media 1" }]], ["slides", [{ title: "A", link: "" }]], ["slides", [{ title: "A", gone: 1 }]],
    ];
    for (const [key, value] of values) {
      const shared = validatePluginSettingValues([COMPONENT.find((each) => each.key === key)!], { [key]: value }).ok;
      expect([key, value, appSettingProblem(component(key), value) === null]).toEqual([key, value, shared]);
    }
    // The one deliberate difference: an item's required text left empty is nothing written.
    expect(validatePluginSettingValues([COMPONENT.find((each) => each.key === "slides")!], { slides: [{ title: "" }] }).ok).toBe(true);
    expect(appListItemProblems(slides, { title: "" }).get("title")).toEqual({ kind: "required" });
  });
});
