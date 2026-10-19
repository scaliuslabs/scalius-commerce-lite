import { describe, expect, it } from "vitest";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { appProviderSetupPath, appSectionNav, appSectionPath, featureSectionKey, resolveAppSection, usesSections } from "./app-sections";

const feature = (id: string, providers: Array<{ id: string; kind: string }>, enabled = false) => ({
  id,
  name: id,
  description: "",
  enabled,
  recommended: false,
  settings: [],
  pages: [],
  request: { providers: providers.map((provider) => ({ ...provider, name: provider.id, icon: null })), scopes: [], allowedHosts: [], functions: [], events: [], cron: [], admin: false, storefront: false, publicRoutes: false },
});

const pack = (overrides: Partial<AppDetail> = {}) => ({
  id: "scalius.bangladesh",
  features: [
    feature("places", []),
    feature("bkash", [{ id: "bkash", kind: "payment" }], true),
    feature("couriers", [{ id: "pathao", kind: "courier" }, { id: "steadfast", kind: "courier" }]),
    feature("settings", [{ id: "fx", kind: "fx" }]),
  ],
  providers: [],
  cron: [],
  settings: { fields: [], values: {}, secrets: {}, missing: [], sections: [] },
  ...overrides,
}) as unknown as AppDetail;

describe("app sections", () => {
  it("lists Overview, the features under their kind, then Activity (Settings only with fields of its own)", () => {
    const nav = appSectionNav(pack());
    expect(nav.map((entry) => [entry.group, entry.sections.map((section) => section.key)])).toEqual([
      [null, ["overview"]],
      ["payment", ["bkash"]],
      ["courier", ["couriers"]],
      ["other", ["places", "settings-feature"]],
      [null, ["activity"]],
    ]);
  });

  it("resolves a feature by its key, or by the id of a provider it owns, from a capability page's link", () => {
    expect(resolveAppSection(pack(), "bkash")).toMatchObject({ kind: "feature", key: "bkash" });
    expect(resolveAppSection(pack(), "steadfast")).toMatchObject({ kind: "feature", key: "couriers" });
    expect(resolveAppSection(pack(), "scalius.bangladesh:pathao")).toMatchObject({ kind: "feature", key: "couriers" });
    expect(resolveAppSection(pack(), undefined)).toMatchObject({ kind: "overview" });
    expect(resolveAppSection(pack(), "activity")).toMatchObject({ kind: "activity" });
    // A feature named like a built-in section keeps its own address.
    expect(featureSectionKey({ id: "settings" })).toBe("settings-feature");
    expect(resolveAppSection(pack(), "settings-feature")).toMatchObject({ kind: "feature", key: "settings-feature" });
    expect(resolveAppSection(pack(), "nothing-here")).toBeNull();
  });

  it("keeps an app without features on one page", () => {
    expect(usesSections(pack())).toBe(true);
    expect(usesSections(pack({ features: [] }))).toBe(false);
  });

  it("builds addresses: the overview at the app's own, a provider's setup at its feature's", () => {
    expect(appSectionPath("scalius.bangladesh", "overview")).toBe("/admin/apps/scalius.bangladesh");
    expect(appSectionPath("scalius.bangladesh", "bkash")).toBe("/admin/apps/scalius.bangladesh/bkash");
    expect(appProviderSetupPath("scalius.bangladesh:bkash")).toBe("/admin/apps/scalius.bangladesh/bkash");
    expect(appProviderSetupPath("stripe")).toBe("/admin/apps");
  });
});
