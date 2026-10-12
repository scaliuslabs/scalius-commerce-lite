// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/transport", () => mocks);
import { POST } from "@/pages/api/checkout/recovery-status";

const TOKEN = `cst_${"a".repeat(64)}`;
function post(statusToken: string = TOKEN, origin = "https://shop.test") {
  return POST({ request: new Request("https://shop.test/api/checkout/recovery-status", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ statusToken }),
  }) } as never);
}
beforeEach(() => mocks.apiFetch.mockReset());

describe("checkout recovery status proxy", () => {
  it.each(["expired", "completed"])("returns only %s status and order identity, never upstream proof or errors", async (status) => {
    mocks.apiFetch.mockResolvedValue(Response.json({ success: true, data: {
      status, orderId: "order_1", checkoutToken: "chk_private", error: "private provider error",
    } }));
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toEqual({ success: true, data: { status, orderId: "order_1" } });
    expect(mocks.apiFetch).toHaveBeenCalledWith(`/orders/status/${TOKEN}`,
      { cache: "no-store" }, { auth: false, retries: 0, timeout: 5_000 });
  });

  it("does not mistake processing, failed or missing orders for expiry", async () => {
    for (const status of ["processing", "failed", "missing"]) {
      mocks.apiFetch.mockResolvedValueOnce(Response.json({ success: true, data: { status } }));
      expect(await (await post()).json()).toEqual({ success: true, data: { status: "unknown" } });
    }
  });

  it("rejects cross-origin requests and receipt proofs before calling the API", async () => {
    expect((await post(TOKEN, "https://other.test")).status).toBe(403);
    expect((await post("chk_private_receipt")).status).toBe(400);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("fails closed on upstream failures and invalid responses", async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error("offline"));
    expect((await post()).status).toBe(503);
    mocks.apiFetch.mockResolvedValueOnce(new Response("", { status: 404 }));
    expect((await post()).status).toBe(503);
    mocks.apiFetch.mockResolvedValueOnce(Response.json({ success: true, data: {} }));
    expect((await post()).status).toBe(502);
  });
});
