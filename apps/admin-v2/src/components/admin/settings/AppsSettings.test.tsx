// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { translate } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { appsMessages } from "~/i18n/settings-apps";

import { FraudCheckCard, ScannerCard, TrackingCard } from "./AppsSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = (data: unknown) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });

const sdk = vi.hoisted(() => ({
  getApiV1AdminAnalytics: vi.fn(),
  getApiV1AdminSettingsMetaConversions: vi.fn(),
  postApiV1AdminSettingsMetaConversions: vi.fn(),
  getApiV1AdminFraudChecker: vi.fn(),
  postApiV1AdminFraudChecker: vi.fn(),
  getApiV1AdminSettingsProviders: vi.fn(),
  postApiV1AdminSettingsProvidersByIdTest: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let host: HTMLDivElement;
let root: Root;

const apps = (key: keyof (typeof appsMessages)["en"]) => translate(appsMessages, key);

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function render(permissions: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionProvider permissions={permissions}>
          <TrackingCard />
          <FraudCheckCard />
          <ScannerCard />
        </PermissionProvider>
      </QueryClientProvider>,
    ),
  );
  await flush();
}

function button(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find((element) => element.textContent?.includes(text));
  if (!match) throw new Error(`No button "${text}"`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  sdk.getApiV1AdminAnalytics.mockImplementation(() =>
    ok({ scripts: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } }));
  sdk.getApiV1AdminFraudChecker.mockImplementation(() =>
    ok({ providers: [], pagination: { page: 1, limit: 20, hasMore: false } }));
  sdk.postApiV1AdminSettingsMetaConversions.mockImplementation(() => ok({}));
  sdk.getApiV1AdminSettingsProviders.mockImplementation(() => ok({ providers: [] }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Settings → Apps cards", () => {
  it("hides the cards a role can't view and locks what it can't change", async () => {
    await render(["analytics.view"]);
    await vi.waitFor(() => expect(document.body.textContent).toContain(apps("noOtherTracking")));

    expect(document.body.textContent).toContain(apps("trackingTitle"));
    expect(document.body.textContent).not.toContain(apps("fraudTitle"));
    expect(document.body.textContent).not.toContain(apps("scannerTitle"));
    expect(button(apps("addTracking")).disabled).toBe(true);
    expect(sdk.getApiV1AdminFraudChecker).not.toHaveBeenCalled();
  });

  it("keeps only your own code and Cloudflare in Other tracking", async () => {
    const summary = (id: string, type: string) => ({
      id, name: id, type, isActive: true, usePartytown: true, location: "head", revision: 1, identifier: null,
      readiness: "ready", configIssue: null, createdAt: null, updatedAt: null, deletedAt: null,
    });
    sdk.getApiV1AdminAnalytics.mockImplementation(() => ok({
      scripts: [summary("Chat widget", "custom"), summary("Meta pixel", "facebook_pixel"), summary("Beacon", "cloudflare_web_analytics")],
      pagination: { page: 1, limit: 100, total: 3, totalPages: 1 },
    }));
    await render(["analytics.view", "analytics.toggle"]);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Chat widget"));
    expect(document.body.textContent).toContain("Beacon");
    expect(document.body.textContent).not.toContain("Meta pixel");
    // A tag's on/off is saved with the page: a checkbox (F9).
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
    expect(document.querySelector('[role="switch"]')).toBeNull();
  });

  it("offers an installed app's fraud check with its readiness and test", async () => {
    const radar = {
      id: "acme.notify:radar",
      kind: "courier_history",
      pluginId: "acme.notify",
      appName: "Acme Notify",
      name: "Acme Radar",
      operations: ["check", "testConnection"],
      canTestConnection: true,
      readiness: { configured: true, enabled: true, usable: true, missingFields: [], credentialErrors: [] },
      environment: "live",
      connection: { status: "passed", testedAt: "2026-10-19T08:00:00.000Z", message: null },
    };
    sdk.getApiV1AdminSettingsProviders.mockImplementation(() => ok({ providers: [radar] }));
    sdk.postApiV1AdminSettingsProvidersByIdTest.mockImplementation(() => ok({ ok: true, message: "Radar reachable." }));
    sdk.postApiV1AdminFraudChecker.mockImplementation(() =>
      ok({ id: "row_radar", name: "Acme Radar", isActive: true, providerType: radar.id }));
    await render(["settings.fraud_checker.view", "settings.fraud_checker.edit"]);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Acme Radar"));
    expect(sdk.getApiV1AdminSettingsProviders).toHaveBeenCalledWith({ query: { kind: "courier_history" } });

    await click(button("Acme Radar"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    // An app not chosen yet is off; its keys live in the app.
    expect(dialog.querySelector('[role="checkbox"]')!.getAttribute("aria-checked")).toBe("false");
    await click(button("Test connection"));
    await vi.waitFor(() => expect(dialog.textContent).toContain("Radar reachable."));
    expect(sdk.postApiV1AdminSettingsProvidersByIdTest).toHaveBeenCalledWith({ path: { id: radar.id } });

    await click(dialog.querySelector<HTMLButtonElement>('[role="checkbox"]')!);
    await click(button(translate(settingsMessages, "save")));
    expect(sdk.postApiV1AdminFraudChecker).toHaveBeenCalledWith({
      body: { name: "Acme Radar", providerType: radar.id, isActive: true },
    });
  });
});
