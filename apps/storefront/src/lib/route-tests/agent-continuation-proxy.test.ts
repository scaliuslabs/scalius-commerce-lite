// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/lib/api/transport", () => mocks);

import { ALL } from "../../pages/api/agent-continuations/[...path]";
import { getAgentContinuationCookieName } from "../agent-continuation-cookie";

const ID = `acn_${"a".repeat(20)}`;
const ORIGIN = "https://storefront.example.test";
const PROOF = `chk_${"p".repeat(40)}`;

function call(path: string, init: { method?: string; body?: string; cookie?: string | null } = {}) {
  const cookie = init.cookie === undefined
    ? `${getAgentContinuationCookieName(ID)}=${ID}`
    : init.cookie;
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  return ALL({
    request: new Request(`${ORIGIN}/api/agent-continuations/${path}`, {
      method: init.method ?? "POST",
      headers,
      body: init.body,
    }),
    params: { path },
  } as never);
}

describe("agent continuation same-origin proxy", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["an unknown action", `${ID}/payment/refund`, undefined],
    ["a malformed continuation id", "acn_short/payment/start", undefined],
    ["a missing claim cookie", `${ID}/payment/start`, null],
    ["another continuation's cookie", `${ID}/payment/start`, `${getAgentContinuationCookieName(`acn_${"b".repeat(20)}`)}=acn_${"b".repeat(20)}`],
  ])("rejects %s before calling the API", async (_label, path, cookie) => {
    const response = await call(path, { body: "{}", cookie });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before calling the API", async () => {
    const response = await call(`${ID}/customer/send-otp`, { body: "x".repeat(16 * 1024 + 1) });
    expect(response.status).toBe(413);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("turns recovered receipt proof into an HttpOnly cookie and strips it from browser JSON", async () => {
    mocks.apiFetch.mockResolvedValue(Response.json({
      success: true,
      data: { orderId: "order_1", receiptProof: PROOF },
    }));

    const response = await call(`${ID}/recovery/verify-otp`, { body: JSON.stringify({ code: "123456" }) });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ success: true, data: { recovered: true, orderId: "order_1" } });
    expect(text).not.toContain(PROOF);
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(PROOF);
    expect(cookie).toContain("HttpOnly");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      `/storefront/agent-continuations/${ID}/recovery/verify-otp`,
      expect.objectContaining({ method: "POST", cache: "no-store" }),
      expect.objectContaining({ auth: true, retries: 0 }),
    );
  });
});
