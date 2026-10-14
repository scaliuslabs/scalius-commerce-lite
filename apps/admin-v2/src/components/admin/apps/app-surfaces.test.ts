// Where an app appears and how search finds it, checked against the real
// first-party manifests: the Bangladesh pack (providers on four capability
// pages, a settings page) and Hello (every dashboard and storefront surface).
import { describe, expect, it } from "vitest";
import {
  appSettingsSections,
  parsePluginManifest,
  providerOwnSettingKeys,
  providerSettingKeys,
  type PluginManifest,
} from "@scalius/shared/plugins";
import { PROVIDER_KINDS, qualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { SETTINGS_NAV } from "../settings/settings-nav";
import { SETTINGS_CARDS } from "../settings/settings-search";
import { APP_PROVIDER_KINDS, PROVIDER_CAPABILITY, providerFromHash, providerHash } from "./app-capabilities";
import { searchAppSurfaces } from "./app-search";
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

/** The parts of `GET /admin/apps/{id}` "Where this app appears" reads, as the API builds them. */
function detailOf(manifest: PluginManifest, status: AppDetail["status"] = "active"): AppDetail {
  return {
    id: manifest.id,
    name: manifest.name,
    status,
    providers: manifest.providers.map((provider) => ({
      id: qualifiedProviderId(manifest.id, provider.id),
      providerId: provider.id,
      kind: provider.kind,
      name: provider.name,
      icon: null,
      settings: providerSettingKeys(manifest, provider.id),
      own: providerOwnSettingKeys(manifest, provider.id).length > 0,
      required: provider.settings ?? [],
    })),
    settings: { fields: [], values: {}, secrets: {}, missing: [], sections: appSettingsSections(manifest) },
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
      productBlocks: manifest.storefront.productBlocks.map(({ type, name, placement }) => ({ type, name, placement })),
      scripts: [],
    },
  } as unknown as AppDetail;
}

describe("where an app appears", () => {
  it("links every Bangladesh pack provider to its capability's setup sheet, and its settings page", async () => {
    const manifest = await manifestOf("bangladesh");
    const entries = appearsEntries(detailOf(manifest));
    // Every provider, each on its capability page with its sheet open.
    expect(manifest.providers).toHaveLength(13);
    for (const provider of manifest.providers) {
      const id = qualifiedProviderId(manifest.id, provider.id);
      const entry = entries.find((candidate) => candidate.key === `provider:${id}`);
      expect(entry, provider.id).toMatchObject({ group: "settings", label: provider.name, to: PROVIDER_CAPABILITY[provider.kind].to });
      expect(providerFromHash(`#${entry!.hash}`)).toBe(id);
    }
    expect(entries.find((entry) => entry.key === "provider:scalius.bangladesh:smsnetbd")?.to).toBe("/admin/settings/notifications");
    expect(entries.find((entry) => entry.key === "provider:scalius.bangladesh:pathao")?.to).toBe("/admin/settings/shipping");
    expect(entries.find((entry) => entry.key === "provider:scalius.bangladesh:fraudbd")?.to).toBe("/admin/settings/integrations");
    expect(entries.find((entry) => entry.key === "provider:scalius.bangladesh:sslcommerz")?.to).toBe("/admin/settings/payments");
    // Its places page is a settings page; it has no app-wide settings, so no "App settings" entry.
    expect(entries.find((entry) => entry.key === "page:places")).toMatchObject({ group: "settings", to: "/admin/apps/scalius.bangladesh/pages/places" });
    expect(entries.some((entry) => entry.key === "settings")).toBe(false);
    expect(entries).toHaveLength(manifest.providers.length + manifest.admin.pages.length);
  });

  it("lists every Hello surface: pages, cards, actions, Home card, theme section and product block, and its settings", async () => {
    const manifest = await manifestOf("hello");
    const entries = appearsEntries(detailOf(manifest));
    const keys = entries.map((entry) => entry.key);
    expect(keys).toEqual([
      "settings",
      ...manifest.admin.pages.map((page) => `page:${page.id}`),
      ...manifest.admin.cards.map((card) => `card:${card.id}`),
      ...manifest.admin.actions.map((action) => `action:${action.id}`),
      ...manifest.admin.widgets.map((widget) => `widget:${widget.id}`),
      ...manifest.storefront.sections.map((section) => `section:${section.type}`),
      ...manifest.storefront.productBlocks.map((block) => `block:${block.type}`),
    ]);
    expect(entries.find((entry) => entry.key === "card:greeting")).toMatchObject({ group: "resources", to: "/admin/orders", detail: { message: "card", target: "order" } });
    expect(entries.find((entry) => entry.key === "action:wave")).toMatchObject({ to: "/admin/products", detail: { message: "bulkAction", target: "product" } });
    expect(entries.find((entry) => entry.key === "settings")).toMatchObject({ to: "/admin/apps/acme.hello", search: { tab: "settings" } });
  });

  it("names an inactive app's pages and sections without linking them; its providers still link", async () => {
    const hello = appearsEntries(detailOf(await manifestOf("hello"), "installed"));
    expect(hello.filter((entry) => entry.key !== "settings").every((entry) => entry.to === null)).toBe(true);
    const pack = appearsEntries(detailOf(await manifestOf("bangladesh"), "installed"));
    expect(pack.filter((entry) => entry.key.startsWith("provider:")).every((entry) => entry.to !== null)).toBe(true);
  });
});

describe("provider kinds", () => {
  it("has a capability page and card for every kind the platform has", () => {
    expect([...APP_PROVIDER_KINDS].sort()).toEqual([...PROVIDER_KINDS].sort());
    for (const kind of APP_PROVIDER_KINDS) {
      const capability = PROVIDER_CAPABILITY[kind];
      expect(SETTINGS_NAV.some((item) => item.key === capability.page && item.to === capability.to), kind).toBe(true);
      // The card is a settings card, so search and the setup-sheet link can find it.
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

  it("opens a new kind's provider sheet on its capability page from dashboard search", () => {
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
      to: "/admin/settings/markets",
      hash: providerHash("acme.rates:daily"),
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

  it("opens a provider's setup sheet where its capability lives", () => {
    expect(searchAppSurfaces([pack()], "pathao", all, kinds)).toEqual([{
      id: "provider:scalius.bangladesh:pathao",
      kind: "provider",
      label: "Pathao",
      app: "Bangladesh pack",
      providerKind: "courier",
      to: "/admin/settings/shipping",
      hash: providerHash("scalius.bangladesh:pathao"),
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
    const noShipping = (path: string) => path !== "/admin/settings/shipping" && path !== "/admin/apps";
    expect(searchAppSurfaces([pack()], "pathao", noShipping, kinds)).toEqual([]);
    expect(searchAppSurfaces([pack()], "bangladesh", noShipping, kinds)).toEqual([]);
  });
});
