// @vitest-environment happy-dom
// Integrations' destination cards: one per platform, each with its tag, the
// sales the store sends itself (reusing the tag's ID), the test mode and the
// last day's health.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminAnalytics: vi.fn(),
  getApiV1AdminSettingsTracking: vi.fn(),
  postApiV1AdminSettingsTracking: vi.fn(),
  getApiV1AdminAnalyticsTrackingHealth: vi.fn(),
  postApiV1AdminAnalyticsTestEvent: vi.fn(),
  getApiV1AdminSettingsMetaConversions: vi.fn(),
  postApiV1AdminSettingsMetaConversions: vi.fn(),
  getApiV1AdminSettingsMetaConversionsLogs: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveScope, type SaveScopeState } from "../shared/SaveBar";
import TrackingDestinationCards, { countsLine } from "./TrackingDestinations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const MASK = "••••••••••••";
const SETTINGS = {
  consent: { otherRegions: "notice", revision: 2 },
  ga4: { isEnabled: false, measurementId: null, apiSecret: null, debugMode: false, revision: 5 },
  tiktok: { isEnabled: false, pixelCode: null, accessToken: null, testEventCode: null, revision: 1 },
};
const script = (id: string, type: string, identifier: string | null) => ({
  id, name: id, type, isActive: true, usePartytown: true, location: "head", revision: 1, identifier,
  readiness: "ready", configIssue: null, createdAt: null, updatedAt: null, deletedAt: null,
});
const HEALTH = {
  windowHours: 24,
  since: "2026-10-19T12:00:00.000Z",
  consent: { otherRegions: "notice", orders: 10, analyticsGranted: 8, marketingGranted: 6, saleOfDataGranted: 7, bySource: { banner: 4, default: 6, gpc: 0 } },
  matchSignalCoverage: { orders: 10, percent: {} },
  destinations: [
    { destination: "meta", configured: true, testMode: true, events: [{ event: "Purchase", sent: 9, failed: 1, skipped: 0, pending: 0 }, { event: "AddToCart", sent: 0, failed: 0, skipped: 0, pending: 0 }], skippedByConsent: 2, matchSignals: {}, lastError: { at: "2026-10-20T08:00:00.000Z", message: "Invalid token" } },
    { destination: "ga4", configured: true, testMode: false, events: [], skippedByConsent: 0, matchSignals: {}, lastError: null },
    { destination: "tiktok", configured: false, testMode: false, events: [], skippedByConsent: 0, matchSignals: {}, lastError: null },
  ],
};

describe("tracking destination cards", () => {
  let root: Root;
  let container: HTMLDivElement;
  const scope: { current: SaveScopeState | null } = { current: null };

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminAnalytics.mockImplementation(() => envelope({
      scripts: [script("TikTok pixel", "tiktok_pixel", "CLIVE456")],
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    }));
    sdk.getApiV1AdminSettingsTracking.mockImplementation(() => envelope(SETTINGS));
    sdk.postApiV1AdminSettingsTracking.mockImplementation(() => envelope(SETTINGS));
    sdk.getApiV1AdminAnalyticsTrackingHealth.mockImplementation(() => envelope(HEALTH));
    sdk.getApiV1AdminSettingsMetaConversions.mockImplementation(() => envelope({ settings: null }));
    sdk.postApiV1AdminSettingsMetaConversions.mockImplementation(() => envelope({}));
    sdk.getApiV1AdminSettingsMetaConversionsLogs.mockImplementation(() => envelope({ logs: [] }));
    sdk.postApiV1AdminAnalyticsTestEvent.mockImplementation(() =>
      envelope({ destination: "meta", accepted: true, mode: "test_event_code", eventId: "evt_1", details: {} }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  const render = async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={(next) => { scope.current = next; return null; }}>
              <TrackingDestinationCards />
            </SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.querySelector("#ga4-enabled")).not.toBeNull());
    await vi.waitFor(() => expect(container.querySelector("#meta-enabled")).not.toBeNull());
  };
  const click = async (element: Element) => act(async () => (element as HTMLElement).click());
  const type = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("draws one card per destination, each with its tag", async () => {
    await render();
    const text = container.textContent!;
    expect(text).toContain("Google Analytics");
    expect(text).toContain("Facebook & Instagram");
    expect(text).toContain("TikTok");
    expect(text).toContain("No Google tag yet.");
    expect(text).toContain("No Meta pixel yet.");
    expect(container.querySelector("#tiktok")?.textContent).toContain("CLIVE456");
  });

  it("marks Send sales to Google without its keys as a field error the save bar names", async () => {
    await render();
    await click(container.querySelector("#ga4-enabled")!);
    const box = container.querySelector("#ga4-enabled")!;
    await vi.waitFor(() => expect(box.getAttribute("aria-invalid")).toBe("true"));
    expect(box.getAttribute("aria-describedby")).toBe("ga4-enabled-error");
    expect(container.querySelector("#ga4-enabled-error")?.textContent).toBe("Add the measurement ID and API secret to send sales to Google.");
    expect(scope.current?.problems).toContainEqual(expect.objectContaining({ target: "ga4-enabled" }));
    await act(async () => { await scope.current!.saveAll(); });
    expect(sdk.postApiV1AdminSettingsTracking).not.toHaveBeenCalled();
  });

  it("sends TikTok sales with the pixel code its tag already carries", async () => {
    await render();
    // The code comes from the tag: shown, not asked for again.
    expect(container.querySelector("#tiktok-pixel-code")).toBeNull();
    await click(container.querySelector("#tiktok-enabled")!);
    expect(container.querySelector("#tiktok-enabled")!.getAttribute("aria-invalid")).toBe("true");
    type(container.querySelector<HTMLInputElement>("#tiktok-access-token")!, "tok_live");
    await vi.waitFor(() => expect(container.querySelector("#tiktok-enabled")!.getAttribute("aria-invalid")).toBe("false"));
    await act(async () => { await scope.current!.saveAll(); });
    expect(sdk.postApiV1AdminSettingsTracking).toHaveBeenCalledTimes(1);
    expect(sdk.postApiV1AdminSettingsTracking.mock.calls[0]![0].body).toEqual({
      tiktok: { isEnabled: true, pixelCode: "CLIVE456", testEventCode: "", accessToken: "tok_live", expectedRevision: 1 },
    });
  });

  it("says what was sent in plain words, leaving zero counts out, and sends a test sale", async () => {
    await render();
    const meta = container.querySelector("#facebook")!;
    await vi.waitFor(() => expect(meta.textContent).toContain("Sales: 9 sent · 1 failed"));
    expect(meta.textContent).not.toContain("0 skipped");
    expect(meta.textContent).not.toContain("Added to cart");
    expect(meta.textContent).toContain("2 sales not sent because the customer said no");
    expect(meta.textContent).toContain("Invalid token");
    expect(container.querySelector("#tiktok")?.textContent).toContain("Not set up");
    const send = [...meta.querySelectorAll("button")].find((button) => button.textContent === "Send test sale")!;
    await click(send);
    await vi.waitFor(() => expect(meta.textContent).toContain("Accepted. Look for it in Events Manager, Test events."));
    expect(sdk.postApiV1AdminAnalyticsTestEvent).toHaveBeenCalledWith({ body: { destination: "meta" } });
  });

  it("keeps the saved Meta access token by never sending its mask back", async () => {
    sdk.getApiV1AdminSettingsMetaConversions.mockImplementation(() =>
      envelope({ settings: { pixelId: "123456789012", accessToken: MASK, testEventCode: MASK, isEnabled: false, logRetentionDays: 30 }, revision: 4 }));
    await render();
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#meta-token")?.value).toBe(MASK));
    await click(container.querySelector("#meta-enabled")!);
    await act(async () => { await scope.current!.saveAll(); });
    expect(sdk.postApiV1AdminSettingsMetaConversions).toHaveBeenCalledWith({
      body: { pixelId: "123456789012", isEnabled: true, expectedRevision: 4 },
    });
  });

  it("won't send Meta sales without a pixel ID and access token", async () => {
    await render();
    await click(container.querySelector("#meta-enabled")!);
    await vi.waitFor(() => expect(container.querySelector("#meta-enabled")!.getAttribute("aria-invalid")).toBe("true"));
    expect(container.querySelector("#meta-enabled-error")?.textContent).toBe("Add the pixel ID and access token to turn this on.");
    await act(async () => { await scope.current!.saveAll(); });
    expect(sdk.postApiV1AdminSettingsMetaConversions).not.toHaveBeenCalled();
  });
});

describe("counts line", () => {
  const t = (key: string, vars: Record<string, number>) => `${vars.count} ${key}`;
  it("leaves out counts that are zero", () => {
    expect(countsLine({ sent: 3, failed: 0, skipped: 0, pending: 2 }, t)).toBe("3 countSent · 2 countPending");
  });
});
