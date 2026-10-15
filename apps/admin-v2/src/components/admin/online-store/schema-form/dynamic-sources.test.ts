import { describe, expect, it } from "vitest";
import type { CustomFieldDefinition } from "~/lib/api-query-options/custom-fields";
import type { ObjectType } from "~/lib/api-query-options/objects";
import { cardCustomFieldOptions, dynamicSourceOptions, reindexSettingBindings, withSettingBinding } from "./dynamic-sources";

const field = (overrides: Partial<CustomFieldDefinition> = {}) => ({ ownerType: "product", namespace: "custom", key: "material", name: "Material", type: "single_line_text", storefrontVisible: true, ...overrides }) as CustomFieldDefinition;
const object = (overrides: Partial<ObjectType> = {}) => ({ handle: "custom.chart", name: "Size chart", storefront: true, handleEnabled: true, fields: [{ key: "heading", name: "Heading", type: "single_line_text" }, { key: "photo", name: "Photo", type: "media_reference" }], ...overrides }) as ObjectType;

describe("dynamic source choices", () => {
  it("offers only compatible public fields of the current page and public object fields", () => {
    const choices = dynamicSourceOptions("text", "product", [field(), field({ key: "secret", storefrontVisible: false }), field({ key: "customer", ownerType: "customer" }), field({ key: "photo", type: "media_reference" })], [object(), object({ handle: "private.chart", storefront: false })]);
    expect(choices.map((choice) => choice.value)).toEqual(["resource.title", "resource.description", "resource.cf.custom.material", "object.custom.chart.*.heading"]);
    expect(dynamicSourceOptions("image", null, [field()], [object()]).map((choice) => choice.value)).toEqual(["object.custom.chart.*.photo"]);
    expect(dynamicSourceOptions("list", null, [], [object()]).map((choice) => choice.value)).toEqual(["object.custom.chart"]);
  });

  it("offers card fields only from public product definitions", () => {
    expect(cardCustomFieldOptions([field(), field({ storefrontVisible: false }), field({ ownerType: "customer" })])).toEqual([{ value: "custom.material", label: "Material" }]);
  });

  it("keeps qualified plugin namespaces intact and requires handles for record fields", () => {
    expect(dynamicSourceOptions("text", "product", [field({ namespace: "scalius.noor" })], [object({ handle: "scalius.noor.chart" }), object({ handleEnabled: false })]).map((choice) => choice.value)).toContain("object.scalius.noor.chart.*.heading");
    expect(dynamicSourceOptions("text", null, [], [object({ handleEnabled: false })])).toEqual([]);
  });

  it("preserves existing settings, enforces the binding cap, and removes empty metadata", () => {
    const full = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, { source: "resource.title" }]));
    expect(withSettingBinding(full, "extra", "resource.title")).toBe(full);
    expect(withSettingBinding(full, "field0", "resource.description")?.field0).toEqual({ source: "resource.description" });
    expect(withSettingBinding({ title: { source: "resource.title" } }, "title", null)).toBeUndefined();
    expect(full.field0).toEqual({ source: "resource.title" });
  });

  it("carries nested app bindings across item moves and removes only the removed item's sources", () => {
    const bindings = { "slides.0.title": { source: "resource.title" }, "slides.1.title": { source: "resource.description" }, title: { source: "resource.title" } };
    expect(reindexSettingBindings(bindings, "slides", 0, 1)).toEqual({ "slides.1.title": bindings["slides.0.title"], "slides.0.title": bindings["slides.1.title"], title: bindings.title });
    expect(reindexSettingBindings(bindings, "slides", 0, null)).toEqual({ "slides.0.title": bindings["slides.1.title"], title: bindings.title });
  });
});
