// @vitest-environment happy-dom

// Settings › Sales channels and the product page's Publishing card
// (docs/MARKETS-DESIGN.md D6): built-in channels show translated names,
// status and locations; Manage saves only what changed and refuses a channel
// with no active location; the online store's status is locked. A new
// product the merchant has not touched is on every channel; unticking one
// turns that into the list of the others.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "~/i18n";
import { salesChannelsMessages } from "~/i18n/sales-channels";
import { salesChannelNamesMessages } from "~/i18n/sales-channel-names";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsSalesChannels: vi.fn(),
  patchApiV1AdminSettingsSalesChannelsById: vi.fn(),
  postApiV1AdminProductsPublications: vi.fn(),
  putApiV1AdminProductsByIdPublications: vi.fn(),
  getApiV1AdminInventoryLocations: vi.fn(),
  getApiV1AdminInventoryByVariantIdLevels: vi.fn(),
  getApiV1AdminInventoryLevels: vi.fn(),
  postApiV1AdminInventoryLocations: vi.fn(),
  patchApiV1AdminInventoryLocationsByLocationId: vi.fn(),
  postApiV1AdminInventoryLocationsByLocationIdArchive: vi.fn(),
  postApiV1AdminInventoryLocationsByLocationIdUnarchive: vi.fn(),
  postApiV1AdminInventoryLocationsByLocationIdDefault: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search: _search, ...props }: { children: ReactNode; to: string; search?: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SalesChannelsSettings } from "./SalesChannelsSettings";
import { PublishingChannels } from "../../product-form/PublishingChannels";
import type { ProductFormValues } from "../../product-form/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof salesChannelsMessages.en, vars?: Record<string, string | number>) =>
  translate(salesChannelsMessages, key, vars);
const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const channel = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, handle: id, name: id, kind: "catalog_feed", pluginId: null, status: "active", position: 0,
  locationIds: ["loc_main", "loc_branch"], publishedProducts: 12, ...overrides,
});
const location = (id: string, name: string, status = "active") => ({
  id, name, code: id.toUpperCase(), kind: "warehouse", addressLine1: null, addressLine2: null, city: null,
  postalCode: null, countryCode: "BD", phone: null, isDefault: id === "loc_main", status, position: 1, version: 1,
  onHand: 0, stockedSkus: 0, createdAt: "", updatedAt: "",
});
const CHANNELS = [
  channel("sc_online_store", { kind: "online_store", name: "Online store" }),
  channel("sc_google", { name: "Google", locationIds: ["loc_main"] }),
  channel("sc_meta", { name: "Facebook and Instagram", status: "inactive" }),
  channel("acme.tiktok:shop", { kind: "app", pluginId: "acme.tiktok", name: "TikTok Shop" }),
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  notifyManager.setNotifyFunction((callback) => { act(callback); });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sdk.getApiV1AdminSettingsSalesChannels.mockImplementation(() => ok({ items: CHANNELS }));
  sdk.getApiV1AdminInventoryLocations.mockImplementation(() => ok({
    locations: [location("loc_main", "Main warehouse"), location("loc_branch", "Chattogram branch")],
  }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  notifyManager.setNotifyFunction((callback) => callback());
  setLocale("en");
});

async function render(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><PermissionProvider isSuperAdmin>{node}</PermissionProvider></QueryClientProvider>);
  });
}

const labelled = (text: string) => [...document.querySelectorAll("label")].find((label) => label.textContent?.includes(text))!;
const button = (text: string) => [...document.querySelectorAll("button")].find((entry) => entry.textContent === text)!;

describe("sales channels settings", () => {
  it("lists each channel with its translated name, status, products and locations", async () => {
    setLocale("bn");
    await render(<SalesChannelsSettings />);
    await vi.waitFor(() => expect(container.textContent).toContain(translate(salesChannelNamesMessages, "channel.sc_online_store")));
    const rows = [...container.querySelectorAll("li")].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain(t("on"));
    expect(rows[0]).toContain(t("allLocations"));
    expect(rows[1]).toContain(t("someLocations", { count: "১", total: "২" }));
    expect(rows[2]).toContain(t("off"));
    // An app's channel keeps its own name and names its app.
    expect(rows[3]).toContain("TikTok Shop");
    expect(rows[3]).toContain(t("about.app", { app: "acme.tiktok" }));
  });

  it("leaves locations out for a store with one, and gives the online store nothing to manage", async () => {
    sdk.getApiV1AdminInventoryLocations.mockImplementation(() => ok({ locations: [location("loc_main", "Main warehouse")] }));
    await render(<SalesChannelsSettings />);
    await vi.waitFor(() => expect(container.querySelectorAll("li")).toHaveLength(4));
    await vi.waitFor(() => expect(sdk.getApiV1AdminInventoryLocations).toHaveBeenCalled());
    const rows = [...container.querySelectorAll("li")];
    expect(container.textContent).not.toContain(t("allLocations"));
    expect(rows[0]!.querySelector("button")).toBeNull();
    act(() => rows[1]!.querySelector("button")!.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain(t("statusOn")));
    expect(document.body.textContent).not.toContain(t("locationsHelp"));
  });

  it("saves only what changed, locks the online store on and needs an active location", async () => {
    sdk.patchApiV1AdminSettingsSalesChannelsById.mockImplementation(() => ok({ channel: CHANNELS[1] }));
    await render(<SalesChannelsSettings />);
    await vi.waitFor(() => expect(container.querySelectorAll("li")).toHaveLength(4));

    act(() => [...container.querySelectorAll("li")][0]!.querySelector("button")!.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain(t("statusLockedStore")));
    expect(labelled(t("statusOn")).querySelector<HTMLButtonElement>("button[role=switch]")!.disabled).toBe(true);
    act(() => button(t("cancel")).click());

    act(() => [...container.querySelectorAll("li")][1]!.querySelector("button")!.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Chattogram branch"));
    act(() => labelled("Main warehouse").querySelector<HTMLButtonElement>("button[role=checkbox]")!.click());
    act(() => button(t("save")).click());
    expect(document.body.textContent).toContain(t("locationsRequired"));
    expect(sdk.patchApiV1AdminSettingsSalesChannelsById).not.toHaveBeenCalled();

    act(() => labelled("Chattogram branch").querySelector<HTMLButtonElement>("button[role=checkbox]")!.click());
    await act(async () => button(t("save")).click());
    expect(sdk.patchApiV1AdminSettingsSalesChannelsById).toHaveBeenCalledWith({
      path: { id: "sc_google" },
      body: { locationIds: ["loc_branch"] },
    });
  });
});

function PublishingHarness({ initial, onValue }: { initial: string[] | null; onValue: (value: string[] | null) => void }) {
  const form = useForm<ProductFormValues>({ defaultValues: { salesChannelIds: initial } as Partial<ProductFormValues> });
  form.watch((values) => onValue((values.salesChannelIds ?? null) as string[] | null));
  return <PublishingChannels form={form} readOnly={false} />;
}

describe("publishing card", () => {
  it("shows a new product on every channel and keeps the others when one is unticked", async () => {
    const values: Array<string[] | null> = [];
    await render(<PublishingHarness initial={null} onValue={(value) => values.push(value)} />);
    // A globally off channel cannot be summarized as available, even when selected.
    await vi.waitFor(() => expect(container.textContent).toContain(t("publishingNew")));
    const boxes = () => [...container.querySelectorAll<HTMLButtonElement>("button[role=checkbox]")];
    expect(boxes().map((box) => box.getAttribute("data-state"))).toEqual(["checked", "checked", "checked", "checked"]);
    expect(container.textContent).toContain(t("channelOff"));

    act(() => boxes()[2]!.click());
    expect(values.at(-1)).toEqual(["sc_online_store", "sc_google", "acme.tiktok:shop"]);
  });

  it("shows a saved product's channels and says when it is on none", async () => {
    await render(<PublishingHarness initial={[]} onValue={() => undefined} />);
    await vi.waitFor(() => expect(container.textContent).toContain(t("noChannels")));
    const states = [...container.querySelectorAll<HTMLButtonElement>("button[role=checkbox]")].map((box) => box.getAttribute("data-state"));
    expect(states).toEqual(["unchecked", "unchecked", "unchecked", "unchecked"]);
  });
});
