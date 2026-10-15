import { describe, expect, it } from "vitest";
import { z } from "zod";
import { collectObjectBindingRequests, parseSettingSource, resolveDocumentBindings, resolvePluginSettingBindings, resolveSettingBindings, storefrontSettingBindingsSchema } from "./bindings";
import { storefrontSectionSchema } from "./sections";

describe("dynamic setting sources", () => {
  it("parses plugin namespaces without confusing record handles and fields", () => {
    expect(parseSettingSource("resource.cf.vendor.app.fabric")).toEqual({ kind: "custom-field", namespace: "vendor.app", key: "fabric" });
    expect(parseSettingSource("object.vendor.app.chart.large.title")).toEqual({ kind: "object-field", namespace: "vendor.app", type: "chart", handle: "large", field: "title" });
    expect(parseSettingSource("object.vendor.app.chart")).toEqual({ kind: "object-list", namespace: "vendor.app", type: "chart" });
    expect(storefrontSettingBindingsSchema.safeParse({ "__proto__.x": { source: "resource.title" } }).success).toBe(false);
    expect(storefrontSettingBindingsSchema.safeParse(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`field${i}`, { source: "resource.title" }]))).success).toBe(false);
  });

  it("keeps literal values for missing sources and rejects changed incompatible values", () => {
    const settings = { heading: "Fallback", count: 4 };
    expect(resolveSettingBindings(settings, { heading: { source: "resource.cf.custom.gone" } }, {})).toBe(settings);
    expect(resolveSettingBindings(settings, { count: { source: "resource.cf.custom.count" } }, { resource: { customFields: [{ namespace: "custom", key: "count", type: "integer", value: 100 }] } }, z.object({ heading: z.string(), count: z.number().max(10) }))).toEqual(settings);
  });

  it("formats numeric text in the reader's locale and supports an optional setting", () => {
    const section = { id: "newsletter", type: "newsletter", version: 1, settings: { heading: "", text: "" }, bindings: { heading: { source: "resource.cf.custom.weight" } } };
    const result = resolveDocumentBindings(section, { language: "bn", resource: { customFields: [{ namespace: "custom", key: "weight", type: "integer", value: 12 }] } });
    expect(result.settings.heading).toBe("১২");
    expect(resolveSettingBindings({}, { heading: { source: "resource.title" } }, { resource: { title: "Connected" } }, z.object({ heading: z.string().optional() }))).toEqual({ heading: "Connected" });
  });

  it("binds section list items without changing the literal document", () => {
    const section = { id: "faq", type: "faq", version: 1, settings: { heading: "FAQ", items: [{ question: "Question", answer: "Fallback", bindings: { answer: { source: "resource.description" } } }] } };
    const result = resolveDocumentBindings(section, { resource: { description: "Connected" } }, storefrontSectionSchema);
    expect(result.settings.items[0]!.answer).toBe("Connected");
    expect(section.settings.items[0]!.answer).toBe("Fallback");
  });

  it("maps public object list fields to the target item schema and ignores extra fields", () => {
    const schema = z.object({ rows: z.array(z.object({ label: z.string(), value: z.string() }).strict()) });
    expect(resolveSettingBindings({ rows: [] }, { rows: { source: "object.custom.specs" } }, { objects: { "custom.specs": { records: [{ handle: "one", data: { label: "Material", value: "Cotton", extra: "unused" } }] } } }, schema)).toEqual({ rows: [{ label: "Material", value: "Cotton" }] });
  });

  it("uses live reference URLs and media ids rather than exposing raw ids as links", () => {
    const resource = { customFields: [{ namespace: "custom", key: "related", type: "product_reference", value: "prod_1", reference: { id: "prod_1", url: "/products/related" } }] };
    expect(resolveSettingBindings({ link: "/fallback" }, { link: { source: "resource.cf.custom.related" } }, { resource })).toEqual({ link: "/products/related" });
    expect(resolvePluginSettingBindings([{ key: "cta", type: "link", label: "Link", required: false }], { cta: "/fallback" }, { cta: { source: "resource.cf.custom.related" } }, { resource })).toEqual({ cta: "/products/related" });
  });

  it("collects one request per type with every referenced handle", () => {
    expect(collectObjectBindingRequests({ bindings: { a: { source: "object.custom.specs.one.label" }, b: { source: "object.custom.specs.two.value" }, c: { source: "object.custom.specs" } } })).toEqual([{ namespace: "custom", type: "specs", handles: ["one", "two"], list: true }]);
  });
});
