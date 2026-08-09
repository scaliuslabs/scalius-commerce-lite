import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  createApiUrl: vi.fn((path: string) => `https://api.example.test/api/v1${path}`),
  fetchWithRetry: vi.fn(),
}));

vi.mock("./client", () => ({
  createApiUrl: clientMocks.createApiUrl,
  fetchWithRetry: clientMocks.fetchWithRetry,
}));

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

describe("sendMetaCapiEvent", () => {
  beforeEach(() => {
    clientMocks.createApiUrl.mockClear();
    clientMocks.fetchWithRetry.mockReset();
    clientMocks.fetchWithRetry.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  it("uses a single short no-auth dispatch instead of the storefront SDK retry transport", async () => {
    await sendMetaCapiEvent(payload);

    expect(clientMocks.createApiUrl).toHaveBeenCalledWith("/meta/events");
    expect(clientMocks.fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(clientMocks.fetchWithRetry).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/meta/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        keepalive: true,
      },
      0,
      2500,
      false,
      false,
    );
  });

  it("keeps analytics failures out of buyer flows", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    clientMocks.fetchWithRetry.mockRejectedValueOnce(new Error("network down"));

    await expect(sendMetaCapiEvent(payload)).resolves.toBeUndefined();

    expect(clientMocks.fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
