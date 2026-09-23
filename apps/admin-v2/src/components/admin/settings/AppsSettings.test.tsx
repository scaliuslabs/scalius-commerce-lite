// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";
import { translate } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { appsMessages } from "~/i18n/settings-apps";

import { FacebookCard, FraudCheckCard, ScannerCard, TrackingCard } from "./AppsSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MASK = "••••••••••••";
const ok = (data: unknown) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });

const sdk = vi.hoisted(() => ({
  getApiV1AdminAnalytics: vi.fn(),
  getApiV1AdminSettingsMetaConversions: vi.fn(),
  postApiV1AdminSettingsMetaConversions: vi.fn(),
  getApiV1AdminFraudChecker: vi.fn(),
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
          <FacebookCard />
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

async function openConnection() {
  await vi.waitFor(() => expect(document.body.textContent).toContain(apps("connection")));
  await click(button(apps("connection")));
  await click(document.querySelector<HTMLButtonElement>('[role="dialog"] [role="switch"]')!);
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
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Settings → Apps cards", () => {
  it("hides the cards a role can't view and locks what it can't change", async () => {
    sdk.getApiV1AdminSettingsMetaConversions.mockImplementation(() => ok({ settings: null }));
    await render(["analytics.view"]);
    await vi.waitFor(() => expect(document.body.textContent).toContain(apps("recentEvents")));

    expect(document.body.textContent).toContain(apps("trackingTitle"));
    expect(document.body.textContent).not.toContain(apps("fraudTitle"));
    expect(document.body.textContent).not.toContain(apps("scannerTitle"));
    expect(button(apps("addTracking")).disabled).toBe(true);
    expect(button(apps("connection")).disabled).toBe(true);
    expect(sdk.getApiV1AdminFraudChecker).not.toHaveBeenCalled();
  });

  it("keeps the saved Meta access token by never sending its mask back", async () => {
    sdk.getApiV1AdminSettingsMetaConversions.mockImplementation(() =>
      ok({
        settings: { pixelId: "123456789012", accessToken: MASK, testEventCode: MASK, isEnabled: false, logRetentionDays: 30 },
      }));
    await render(["analytics.view", "analytics.edit"]);
    await openConnection();

    expect(document.querySelector<HTMLInputElement>("#meta-token")!.value).toBe(MASK);
    await click(button(translate(settingsMessages, "save")));

    expect(sdk.postApiV1AdminSettingsMetaConversions).toHaveBeenCalledWith({
      body: { pixelId: "123456789012", isEnabled: true },
    });
  });

  it("won't turn Meta on without a pixel ID and access token", async () => {
    sdk.getApiV1AdminSettingsMetaConversions.mockImplementation(() => ok({ settings: null }));
    await render(["analytics.view", "analytics.edit"]);
    await openConnection();

    expect(document.body.textContent).toContain(apps("needsPixelAndToken"));
    expect(button(translate(settingsMessages, "save")).disabled).toBe(true);
    expect(sdk.postApiV1AdminSettingsMetaConversions).not.toHaveBeenCalled();
  });
});
