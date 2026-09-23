// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMetaCapiEvent, type MetaCapiEventPayload } from "./tracking";

const payload: MetaCapiEventPayload = {
  eventId: "ViewContent:event_1",
  eventName: "ViewContent",
  eventSourceUrl: "https://storefront.example.test/products/shoe",
  userData: {
    client_user_agent: "test-agent",
  },
  customData: {
    content_ids: ["sku_1"],
    content_type: "product",
  },
};

const fetchMock = vi.fn();

describe("sendMetaCapiEvent", () => {
  beforeEach(() => {
    window.__API_BASE_URL__ = "https://api.example.test/api/v1";
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    delete window.__API_BASE_URL__;
    vi.unstubAllGlobals();
  });

  it("sends one short keepalive POST to the public API without retries", async () => {
    await sendMetaCapiEvent(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/v1/meta/events");
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify(payload),
      cache: "no-store",
      keepalive: true,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps analytics failures out of buyer flows", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await expect(sendMetaCapiEvent(payload)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
