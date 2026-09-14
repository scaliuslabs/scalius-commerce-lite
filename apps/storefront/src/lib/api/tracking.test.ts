import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("./transport", () => ({
  apiFetch: clientMocks.apiFetch,
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
    clientMocks.apiFetch.mockReset();
    clientMocks.apiFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  });

  it("uses a single short no-auth dispatch instead of the storefront SDK retry transport", async () => {
    await sendMetaCapiEvent(payload);

    expect(clientMocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(clientMocks.apiFetch).toHaveBeenCalledWith(
      "/meta/events",
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
      { retries: 0, timeout: 2500, auth: false, logTerminalFailure: false },
    );
  });

  it("keeps analytics failures out of buyer flows", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    clientMocks.apiFetch.mockRejectedValueOnce(new Error("network down"));

    await expect(sendMetaCapiEvent(payload)).resolves.toBeUndefined();

    expect(clientMocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
