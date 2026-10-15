// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api/transport", () => ({
  resolveBackendTarget: (path: string) => ({ url: `https://api.internal${path}`, fetch: api.fetch }),
}));

import { readAccountSummaryForRequest } from "./account-server";

const request = () => new Request("https://shop.test/account", { headers: { Cookie: "cs_tok=customer-session; unrelated=private" } });

beforeEach(() => api.fetch.mockReset());

describe("account summary buyer UI", () => {
  it("keeps private UI from the existing authenticated summary read", async () => {
    const buyerUi = [{
      appId: "example.loyalty", releaseId: "release_1", target: "customer-account.order-index.block.render",
      ui: { type: "text", text: "You have 200 points" }, attributes: [], values: {},
    }];
    api.fetch.mockResolvedValue(Response.json({ success: true, data: { unreadInbox: 2, buyerUi } }));

    const summary = await readAccountSummaryForRequest(request());

    expect(summary).toMatchObject({ unreadInbox: 2, buyerUi });
    expect(api.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = api.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.internal/api/v1/customer-auth/account-summary");
    expect(init.headers.get("Cookie")).toBe("cs_tok=customer-session");
    expect(init.headers.get("x-storefront-language")).toBe("en");
    expect(init.headers.get("x-storefront-locale")).toBe("en-BD");
  });

  it("omits malformed UI and makes no read without the customer session", async () => {
    api.fetch.mockResolvedValue(Response.json({ success: true, data: { buyerUi: "<script>bad</script>" } }));
    expect(await readAccountSummaryForRequest(request())).not.toHaveProperty("buyerUi");
    api.fetch.mockClear();
    expect(await readAccountSummaryForRequest(new Request("https://shop.test/account"))).toBeNull();
    expect(api.fetch).not.toHaveBeenCalled();
  });
});
