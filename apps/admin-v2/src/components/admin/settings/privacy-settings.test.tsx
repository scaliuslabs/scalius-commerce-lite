// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsTracking: vi.fn(),
  postApiV1AdminSettingsTracking: vi.fn(),
  getApiV1AdminAnalyticsTrackingHealth: vi.fn(),
  postApiV1AdminAnalyticsTestEvent: vi.fn(),
  getApiV1AdminSettingsMarkets: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, hash, children, ...props }: { to: string; hash?: string; children: ReactNode }) => (
    <a href={hash ? `${to}#${hash}` : to} {...props}>{children}</a>
  ),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { SaveScope, type SaveScopeState } from "../shared/SaveBar";
import { CookieBannerCard, CustomerDataCard } from "./PrivacySettings";
import { privacyProblems, tagIdsFrom, trackingSaveBody, withTagIds, type PrivacyValues } from "./tracking-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const MASK = "••••••••••••";
const SETTINGS = {
  consent: { otherRegions: "notice", revision: 2 },
  ga4: { isEnabled: true, measurementId: "G-ABC1234", apiSecret: MASK, debugMode: false, revision: 5 },
  tiktok: { isEnabled: false, pixelCode: null, accessToken: null, testEventCode: null, revision: 1 },
};
const HEALTH = {
  windowHours: 24,
  since: "2026-10-19T12:00:00.000Z",
  consent: { otherRegions: "notice", orders: 10, analyticsGranted: 8, marketingGranted: 6, saleOfDataGranted: 7, bySource: { banner: 4, default: 6, gpc: 0 } },
  matchSignalCoverage: { orders: 10, percent: { em: 50, ph: 100, fbp: 40 } },
  destinations: [
    { destination: "meta", configured: true, testMode: true, events: [{ event: "Purchase", sent: 9, failed: 1, skipped: 0, pending: 0 }], skippedByConsent: 2, matchSignals: {}, lastError: { at: "2026-10-20T08:00:00.000Z", message: "Invalid token" } },
    { destination: "ga4", configured: true, testMode: false, events: [], skippedByConsent: 0, matchSignals: {}, lastError: null },
    { destination: "tiktok", configured: false, testMode: false, events: [], skippedByConsent: 0, matchSignals: {}, lastError: null },
  ],
};

const values = (overrides: Partial<PrivacyValues> = {}): PrivacyValues => ({
  otherRegions: "notice",
  ga4: { isEnabled: true, measurementId: "G-ABC1234", apiSecret: MASK, debugMode: false },
  tiktok: { isEnabled: false, pixelCode: "", accessToken: "", testEventCode: "" },
  ...overrides,
});

describe("privacy settings save body", () => {
  const revision = { consent: 2, ga4: 5, tiktok: 1 };

  it("sends only the changed sections, each at its own revision", () => {
    expect(trackingSaveBody(values({ otherRegions: "opt_in" }), values(), revision)).toEqual({
      consent: { otherRegions: "opt_in", expectedRevision: 2 },
    });
    const tiktok = { isEnabled: true, pixelCode: " CABC123 ", accessToken: "tok_live", testEventCode: "TEST123" };
    expect(trackingSaveBody(values({ tiktok }), values(), revision)).toEqual({
      tiktok: { isEnabled: true, pixelCode: "CABC123", accessToken: "tok_live", testEventCode: "TEST123", expectedRevision: 1 },
    });
  });

  it("keeps a saved secret unless a new one is typed", () => {
    const debug = values({ ga4: { ...values().ga4, debugMode: true } });
    expect(trackingSaveBody(debug, values(), revision).ga4).toEqual({ isEnabled: true, measurementId: "G-ABC1234", debugMode: true, expectedRevision: 5 });
    const replaced = values({ ga4: { ...values().ga4, apiSecret: "new-secret" } });
    expect(trackingSaveBody(replaced, values(), revision).ga4?.apiSecret).toBe("new-secret");
  });

  it("blocks turning a destination on without its IDs, and malformed IDs", () => {
    expect(privacyProblems(values())).toEqual({});
    expect(privacyProblems(values({ ga4: { ...values().ga4, measurementId: "UA-123" } }))).toEqual({ "ga4-measurement-id": "measurementIdInvalid" });
    expect(privacyProblems(values({ tiktok: { ...values().tiktok, isEnabled: true } }))).toEqual({ "tiktok-enabled": "tiktokNeeds" });
  });

  it("reuses the ID a saved tag carries, so the pixel code is typed once", () => {
    const ids = tagIdsFrom([
      { type: "tiktok_pixel", identifier: "COLD123", isActive: false },
      { type: "tiktok_pixel", identifier: "CLIVE456", isActive: true },
      { type: "google_analytics", identifier: "G-TAG1234", isActive: true },
      { type: "custom", identifier: null, isActive: true },
    ]);
    expect(ids).toEqual({ tiktok: "CLIVE456", ga4: "G-TAG1234" });
    const on = values({ tiktok: { isEnabled: true, pixelCode: "", accessToken: "tok", testEventCode: "" } });
    expect(privacyProblems(on, ids)).toEqual({});
    expect(withTagIds(on, ids, "tiktok").tiktok.pixelCode).toBe("CLIVE456");
    // A code the merchant typed stays theirs.
    const typed = values({ tiktok: { ...on.tiktok, pixelCode: "CTYPED1" } });
    expect(withTagIds(typed, ids, "tiktok").tiktok.pixelCode).toBe("CTYPED1");
  });
});

describe("Settings → Customer privacy", () => {
  let root: Root;
  let container: HTMLDivElement;
  const scope: { current: SaveScopeState | null } = { current: null };

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminSettingsTracking.mockImplementation(() => envelope(SETTINGS));
    sdk.postApiV1AdminSettingsTracking.mockImplementation(({ body }: { body: { consent?: { otherRegions: string } } }) =>
      envelope({ ...SETTINGS, consent: { otherRegions: body.consent?.otherRegions ?? "notice", revision: 3 } }));
    sdk.getApiV1AdminAnalyticsTrackingHealth.mockImplementation(() => envelope(HEALTH));
    sdk.getApiV1AdminSettingsMarkets.mockImplementation(() => envelope({ items: [
      { id: "mkt_backup", name: "Bangladesh", countries: ["BD"], isBackup: true },
      { id: "mkt_eu", name: "Europe", countries: ["DE", "FR"], isBackup: false },
    ] }));
    sdk.postApiV1AdminAnalyticsTestEvent.mockImplementation(() =>
      envelope({ destination: "meta", accepted: true, mode: "test_event_code", eventId: "evt_1", details: {} }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    notifyManager.setNotifyFunction((callback) => callback());
  });

  const render = async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>
            <SaveScope render={(next) => { scope.current = next; return null; }}>
              <CookieBannerCard />
              <CustomerDataCard />
            </SaveScope>
          </PermissionProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Cookie banner"));
    await vi.waitFor(() => expect(container.textContent).toContain("What customers allow"));
  };

  it("shows the banner choice, Europe's fixed rule and what each market gets", async () => {
    await render();
    expect(container.textContent).toContain("Tell customers");
    await vi.waitFor(() => expect(container.textContent).toContain("Customers there are always asked first."));
    expect(container.textContent).toContain("Everywhere else");
    await vi.waitFor(() => expect(container.textContent).toContain("Required by law"));
    const rows = [...container.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows).toContain("BangladeshTells customers");
    expect(rows).toContain("EuropeAsks first · Required by law");
  });

  it("saves only the banner when only the banner changed", async () => {
    await render();
    const optIn = container.querySelector<HTMLButtonElement>('button[role="radio"][value="opt_in"]')!;
    await act(async () => optIn.click());
    await vi.waitFor(() => expect(scope.current?.dirty).toBe(true));
    await act(async () => { await scope.current!.saveAll(); });
    expect(sdk.postApiV1AdminSettingsTracking).toHaveBeenCalledTimes(1);
    expect(sdk.postApiV1AdminSettingsTracking.mock.calls[0]![0].body).toEqual({ consent: { otherRegions: "opt_in", expectedRevision: 2 } });
    await vi.waitFor(() => expect(scope.current?.dirty).toBe(false));
  });

  it("names Europe's rule only for a store that sells there", async () => {
    sdk.getApiV1AdminSettingsMarkets.mockImplementation(() => envelope({ items: [
      { id: "mkt_backup", name: "Bangladesh", countries: ["BD"], isBackup: true },
    ] }));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Where you sell"));
    expect(container.textContent).not.toContain("Europe, the UK and Switzerland");
    // One market: no list of markets that repeats the choice.
    expect(container.textContent).not.toContain("Your markets");
  });

  it("says what customers allowed, with the match details behind Details", async () => {
    await render();
    expect(container.textContent).toContain("Of 10 orders: 8 allowed visit counting, 6 allowed ads, 7 allowed selling their data.");
    expect(container.textContent).not.toContain("Facebook browser ID");
    const details = await vi.waitFor(() => {
      const button = [...container.querySelectorAll("button")].find((element) => element.textContent === "Details");
      expect(button).toBeTruthy();
      return button!;
    });
    await act(async () => details.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Facebook browser ID"));
  });
});
