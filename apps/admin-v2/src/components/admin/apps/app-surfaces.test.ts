// An app's services, where it appears and how search finds it, checked
// against the real first-party manifests: the Bangladesh pack (fourteen
// features over four kinds of service and a places page) and Hello (every
// dashboard and storefront surface).
import { describe, expect, it } from "vitest";
import {
  appSettingsSections,
  parsePluginManifest,
  pluginFeatureOwners,
  pluginFeatureRequest,
  providerOwnSettingKeys,
  providerSettingKeys,
  type PluginManifest,
} from "@scalius/shared/plugins";
import { PROVIDER_KINDS, qualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { SETTINGS_NAV } from "../settings/settings-nav";
import { SETTINGS_CARDS } from "../settings/settings-search";
import { APP_PROVIDER_KINDS, PROVIDER_CAPABILITY } from "./app-capabilities";
import { searchAppSurfaces } from "./app-search";
import { itemSettingKeys, serviceGroups, serviceSettingKeys } from "./app-services";
import { appearsEntries } from "./AppWhereItAppears";
import type { AppSurfaces } from "./ui/surfaces";

/** The plugin's manifest, loaded at run time (the dashboard never bundles plugin code). */
async function manifestOf(plugin: string): Promise<PluginManifest> {
  // Test apps live in the API test tree; shipped apps in plugins/.
  const dir = plugin === "hello" ? "apps/api/src/plugins/testing/apps/hello" : `plugins/${plugin}`;
  const path = new URL(`../../../../../../${dir}/src/index.ts`, import.meta.url).href;
  const module = (await import(/* @vite-ignore */ path)) as { manifest: unknown };
  const parsed = parsePluginManifest(module.manifest);
  if (!parsed.ok) throw new Error(`${plugin}: ${JSON.stringify(parsed.issues)}`);
  return parsed.manifest;
}

/**
 * The parts of `GET /admin/apps/{id}` the page's services and "Where this
 * app appears" read, as the API builds them: every feature off unless
 * listed in `on` (an off feature's providers and fields are not listed).
 */
function detailOf(manifest: PluginManifest, status: AppDetail["status"] = "active", on: readonly string[] = []): AppDetail {
  const owners = pluginFeatureOwners(manifest);
  const running = (owner: string | undefined) => owner === undefined || on.includes(owner);
  return {
    id: manifest.id,
    name: manifest.name,
    status,
    features: manifest.features.map((feature) => {
      const request = pluginFeatureRequest(manifest, feature.id)!;
      return {
        id: feature.id,
        name: feature.name,
        description: feature.description,
        enabled: on.includes(feature.id),
        recommended: feature.recommended,
        request: {
          ...request,
          scopes: [],
          providers: request.providers.map((provider) => ({ ...provider, id: qualifiedProviderId(manifest.id, provider.id), icon: null })),
        },
        grantKey: null,
        settings: [...owners.settings].filter(([, owner]) => owner === feature.id).map(([key]) => key),
        pages: feature.admin.filter((id) => manifest.admin.pages.some((page) => page.id === id)),
      };
    }),
    cron: [],
    providers: manifest.providers.filter((provider) => running(owners.providers.get(provider.id))).map((provider) => ({
      id: qualifiedProviderId(manifest.id, provider.id),
      providerId: provider.id,
      kind: provider.kind,
      name: provider.name,
      icon: null,
      settings: providerSettingKeys(manifest, provider.id),
      own: providerOwnSettingKeys(manifest, provider.id).length > 0,
      required: provider.settings ?? [],
    })),
    settings: {
      fields: manifest.settings.filter((field) => running(owners.settings.get(field.key))).map((field) => ({ key: field.key, label: field.label, type: field.type })),
      values: {},
      secrets: {},
      missing: [],
      sections: appSettingsSections(manifest),
    },
    admin: {
      pages: manifest.admin.pages.map((page) => ({ ...page, tabs: page.tabs ?? null })),
      cards: manifest.admin.cards.map(({ id, target, title }) => ({ id, target, title })),
      actions: manifest.admin.actions.map(({ id, target, label, bulk }) => ({ id, target, label, bulk })),
      widgets: manifest.admin.widgets.map(({ id, title }) => ({ id, title })),
    },
    storefront: {
      proxy: manifest.storefront.proxy,
      head: manifest.storefront.head,
      sections: manifest.storefront.sections.map(({ type, name }) => ({ type, name })),
      components: manifest.storefront.components.map(({ type, name, targets }) => ({ type, name, targets: [...targets] })),
      scripts: [],
      themeProblems: [],
    },
  } as unknown as AppDetail;
}

describe("an app's services", () => {
  it("groups the Bangladesh pack's fourteen features by service, the group with the recommended one first", async () => {
    const manifest = await manifestOf("bangladesh");
    const groups = serviceGroups(detailOf(manifest));
    expect(groups.map(({ group, items }) => [group, items.map((item) => item.id)])).toEqual([
      ["other", ["feature:places"]],
      ["payment", ["feature:bkash", "feature:nagad", "feature:sslcommerz"]],
      ["courier", ["feature:pathao", "feature:steadfast"]],
      ["sms", ["feature:smsnetbd", "feature:bdbulksms", "feature:mimsms", "feature:gennet"]],
      ["fraud", ["feature:fraudbd", "feature:fraudguard", "feature:ecourier", "feature:fraudchecker"]],
    ]);
    expect(groups.flatMap((group) => group.items)).toHaveLength(14);
  });

  it("shows a feature's own fields with it only while it is on, and none as the app's own settings", async () => {
    const manifest = await manifestOf("bangladesh");
    const off = detailOf(manifest);
    const pathaoOff = serviceGroups(off).flatMap((group) => group.items).find((item) => item.id === "feature:pathao")!;
    expect(itemSettingKeys(off, pathaoOff)).toEqual([]);
    const on = detailOf(manifest, "active", ["pathao"]);
    const pathao = serviceGroups(on).flatMap((group) => group.items).find((item) => item.id === "feature:pathao")!;
    expect(itemSettingKeys(on, pathao)).toEqual(providerSettingKeys(manifest, "pathao"));
    // Every pack field belongs to a feature; the places feature brings its page.
    const all = detailOf(manifest, "active", manifest.features.map((feature) => feature.id));
    expect(serviceSettingKeys(all)).toEqual(new Set(manifest.settings.map((field) => field.key)));
    expect(on.features.find((feature) => feature.id === "places")?.pages).toEqual(["places"]);
  });

  it("lists a provider no feature owns as a row of its own", async () => {
    const manifest = await manifestOf("hello");
    const rows = serviceGroups(detailOf(manifest)).flatMap((group) => group.items);
    expect(rows.map((row) => row.id).sort()).toEqual(manifest.providers.map((provider) => `provider:${qualifiedProviderId(manifest.id, provider.id)}`).sort());
  });
});

describe("where an app appears", () => {
  it("leaves the Bangladesh pack's providers and places page to its service rows", async () => {
    const manifest = await manifestOf("bangladesh");
    expect(appearsEntries(detailOf(manifest, "active", manifest.features.map((feature) => feature.id)))).toEqual([]);
  });

  it("lists every Hello surface: pages, cards, actions, Home card, theme section and product block", async () => {
    const manifest = await manifestOf("hello");
    const entries = appearsEntries(detailOf(manifest));
    expect(entries.map((entry) => entry.key)).toEqual([
      ...manifest.admin.pages.map((page) => `page:${page.id}`),
      ...manifest.admin.cards.map((card) => `card:${card.id}`),
      ...manifest.admin.actions.map((action) => `action:${action.id}`),
      ...manifest.admin.widgets.map((widget) => `widget:${widget.id}`),
      ...manifest.storefront.sections.map((section) => `section:${section.type}`),
      ...manifest.storefront.components.flatMap((component) => component.targets.map((target) => `component:${component.type}:${target}`)),
    ]);
    expect(entries.find((entry) => entry.key === "card:greeting")).toMatchObject({ group: "resources", to: "/admin/orders", detail: { message: "card", target: "order" } });
    expect(entries.find((entry) => entry.key === "action:wave")).toMatchObject({ to: "/admin/products", detail: { message: "bulkAction", target: "product" } });
  });

  it("names an inactive app's pages and sections without linking them", async () => {
    const hello = appearsEntries(detailOf(await manifestOf("hello"), "installed"));
    expect(hello.length).toBeGreaterThan(0);
    expect(hello.every((entry) => entry.to === null)).toBe(true);
  });
});

describe("provider kinds", () => {
  it("has a capability page and card for every kind the platform has", () => {
    expect([...APP_PROVIDER_KINDS].sort()).toEqual([...PROVIDER_KINDS].sort());
    for (const kind of APP_PROVIDER_KINDS) {
      const capability = PROVIDER_CAPABILITY[kind];
      expect(SETTINGS_NAV.some((item) => item.key === capability.page && item.to === capability.to), kind).toBe(true);
      // The card is a settings card, so search and the "Choose it in Settings" link can find it.
      expect(SETTINGS_CARDS.some((card) => card.page === capability.page && card.card === capability.card), kind).toBe(true);
    }
  });

  it("puts each new kind where its capability is, not on the app's own page", () => {
    expect(PROVIDER_CAPABILITY.messaging).toEqual({ page: "notifications", to: "/admin/settings/notifications", card: "chatApps" });
    expect(PROVIDER_CAPABILITY.push).toEqual({ page: "notifications", to: "/admin/settings/notifications", card: "browserNotifications" });
    expect(PROVIDER_CAPABILITY.fx).toEqual({ page: "markets", to: "/admin/settings/markets", card: "exchangeRates" });
    expect(PROVIDER_CAPABILITY.address).toEqual({ page: "checkout", to: "/admin/settings/checkout", card: "addressAutocomplete" });
    expect(PROVIDER_CAPABILITY.identity).toEqual({ page: "customerAccounts", to: "/admin/settings/customer-accounts", card: "otherSignIn" });
    expect(PROVIDER_CAPABILITY.search).toEqual({ page: "integrations", to: "/admin/settings/integrations", card: "appSearch" });
  });

  it("opens a new kind's provider on its feature page in its app from dashboard search", () => {
    const app: AppSurfaces = {
      id: "acme.rates",
      name: "Acme rates",
      pages: [],
      cards: [],
      actions: [],
      widgets: [],
      listColumns: [],
      routes: [],
      providers: [{ id: "acme.rates:daily", providerId: "daily", kind: "fx", name: "Daily rates", icon: null }],
      translations: null,
    };
    expect(searchAppSurfaces([app], "daily", () => true, (kind) => [kind])).toEqual([{
      id: "provider:acme.rates:daily",
      kind: "provider",
      label: "Daily rates",
      app: "Acme rates",
      providerKind: "fx",
      to: "/admin/apps/acme.rates/daily",
    }]);
  });
});

describe("app settings sections", () => {
  it("shows Hello's app-wide settings in its declared groups, general ones first", async () => {
    const sections = appSettingsSections(await manifestOf("hello"));
    expect(sections.map((section) => [section.group?.id ?? null, section.keys])).toEqual([
      [null, ["greeting"]],
      ["discount", ["discount_percent", "min_subtotal_minor"]],
      ["connection", ["api_key", "webhook_secret"]],
    ]);
  });

  it("puts every Bangladesh pack field with its provider: nothing flat, no prefixed labels", async () => {
    const manifest = await manifestOf("bangladesh");
    expect(appSettingsSections(manifest)).toEqual([]);
    const owned = manifest.providers.flatMap((provider) => providerOwnSettingKeys(manifest, provider.id));
    expect(new Set(owned)).toEqual(new Set(manifest.settings.map((field) => field.key)));
    expect(owned).toHaveLength(manifest.settings.length);
    for (const field of manifest.settings) expect(field.label, field.key).not.toMatch(/^[^:]+: /);
    // Optional fields join their provider's sheet; readiness still counts only the declared ones.
    expect(providerSettingKeys(manifest, "pathao")).toEqual([
      "pathao_base_url", "pathao_client_id", "pathao_client_secret", "pathao_username", "pathao_password", "pathao_store_id",
      "pathao_delivery_type", "pathao_item_type", "pathao_item_weight", "pathao_webhook_secret",
    ]);
    expect(manifest.providers.find((provider) => provider.id === "pathao")?.settings).toHaveLength(6);
    expect(providerSettingKeys(manifest, "smsnetbd")).toEqual(["smsnetbd_api_key", "smsnetbd_sender_id"]);
    expect(manifest.translations?.bn?.settings?.pathao_client_id?.label).toBe("ক্লায়েন্ট আইডি");
  });
});

describe("app surfaces in search", () => {
  const pack = (): AppSurfaces => ({
    id: "scalius.bangladesh",
    name: "Bangladesh pack",
    pages: [],
    cards: [],
    actions: [],
    widgets: [],
    listColumns: [],
    routes: [],
    providers: [
      { id: "scalius.bangladesh:pathao", providerId: "pathao", kind: "courier", name: "Pathao", icon: null },
      { id: "scalius.bangladesh:smsnetbd", providerId: "smsnetbd", kind: "sms", name: "SMS.net.bd", icon: null },
    ],
    translations: null,
  });
  const other = (): AppSurfaces => ({
    ...pack(),
    id: "acme.texts",
    name: "Acme texts",
    providers: [{ id: "acme.texts:acme", providerId: "acme", kind: "sms", name: "Acme SMS", icon: null }],
  });
  const kinds = (kind: string) => (kind === "sms" ? ["SMS gateway", "এসএমএস গেটওয়ে"] : kind === "courier" ? ["Courier", "কুরিয়ার"] : [kind]);
  const all = () => true;

  it("opens a provider's own page in its app (its switch and setup)", () => {
    expect(searchAppSurfaces([pack()], "pathao", all, kinds)).toEqual([{
      id: "provider:scalius.bangladesh:pathao",
      kind: "provider",
      label: "Pathao",
      app: "Bangladesh pack",
      providerKind: "courier",
      to: "/admin/apps/scalius.bangladesh/pathao",
    }]);
  });

  it("finds providers of every app by their kind, in either language, and apps by name", () => {
    expect(searchAppSurfaces([pack(), other()], "sms gate", all, kinds).map((hit) => hit.label)).toEqual(["SMS.net.bd", "Acme SMS"]);
    expect(searchAppSurfaces([pack(), other()], "এসএমএস", all, kinds).map((hit) => hit.label)).toEqual(["SMS.net.bd", "Acme SMS"]);
    expect(searchAppSurfaces([pack()], "bangla", all, kinds)).toEqual([
      { id: "app:scalius.bangladesh", kind: "app", label: "Bangladesh pack", app: "Bangladesh pack", to: "/admin/apps/scalius.bangladesh" },
    ]);
  });

  it("leaves out what the staff member cannot open", () => {
    const noApps = (path: string) => path !== "/admin/apps";
    expect(searchAppSurfaces([pack()], "pathao", noApps, kinds)).toEqual([]);
    expect(searchAppSurfaces([pack()], "bangladesh", noApps, kinds)).toEqual([]);
  });
});
