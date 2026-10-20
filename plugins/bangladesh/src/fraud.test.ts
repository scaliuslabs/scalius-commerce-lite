// The Bangladesh fraud checkers over the SDK harness: each service's request,
// and its answer normalized into the courier-history port's `CourierHistory` (validated by
// the harness against the port). The cases are core's tests from before the
// move (modules/fraud-checker/provider.test.ts). Service HTTP is scripted.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import pack from "./index";
import { toLocalPhone } from "./fraud";

interface Call { url: string; headers: Record<string, string>; body: string }

function harness(settings: Record<string, string>, reply: { status?: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const instance = createPluginTestHarness(pack, {
    settings,
    fetch: (url, init) => {
      const request = init as { headers: Record<string, string>; body: string };
      calls.push({ url, headers: request.headers, body: request.body });
      if (reply instanceof Error) throw reply;
      return { status: reply.status ?? 200, body: JSON.stringify(reply.body) };
    },
  });
  return { instance, calls };
}

const FRAUDBD = { fraudbd_api_key: "fraudbd-key", fraudbd_username: "fraudbd-user", fraudbd_password: "fraudbd-password" };

describe("Bangladesh fraud checkers", () => {
  it("calls FraudBD with its documented credentials and normalizes courier stats", async () => {
    const { instance, calls } = harness({ ...FRAUDBD, fraudbd_api_url: "https://api.fraudbd.com/api/check-courier-info" }, {
      body: { data: { mobile_number: "01711111111", totalSummary: { total: 10, success: 8, cancel: 2 }, Summaries: { Steadfast: { total: 6, success: 5, cancel: 1 } } } },
    });
    const result = await instance.provider("fraudbd", "check", { phone: "+8801711111111" });
    expect(calls[0]!.url).toBe("https://api.fraudbd.com/api/check-courier-info");
    expect(calls[0]!.headers).toMatchObject({ api_key: "fraudbd-key", user_name: "fraudbd-user", password: "fraudbd-password" });
    expect(JSON.parse(calls[0]!.body)).toEqual({ phone_number: "01711111111" });
    expect(result.value).toMatchObject({
      riskLevel: "medium",
      totalParcels: 10,
      delivered: 8,
      cancelled: 2,
      couriers: { Steadfast: { totalParcels: 6, delivered: 5, cancelled: 1 } },
    });
  });

  it("uses the service's published address by default", async () => {
    const { instance, calls } = harness(FRAUDBD, { body: { data: { total: 0, success: 0, cancel: 0 } } });
    await instance.provider("fraudbd", "check", { phone: "+8801711111111" });
    expect(calls[0]!.url).toBe("https://fraudbd.com/api/check-courier-info");
  });

  it("calls FraudGuard with key and secret headers", async () => {
    const { instance, calls } = harness({ fraudguard_api_key: "guard-key", fraudguard_api_secret: "guard-secret" }, {
      body: { data: { summary: { total_orders: 4, successful_delivery: 3, cancelled_delivery: 1 }, courier_stats: [{ courier: "Pathao", total_orders: 4, successful_delivery: 3, cancelled_delivery: 1 }] } },
    });
    const result = await instance.provider("fraudguard", "check", { phone: "+8801811111111" });
    expect(calls[0]!.headers).toMatchObject({ "X-API-KEY": "guard-key", "X-API-SECRET": "guard-secret" });
    expect(JSON.parse(calls[0]!.body)).toEqual({ phone_number: "01811111111" });
    expect(result.value).toMatchObject({ totalParcels: 4, delivered: 3, cancelled: 1, couriers: { Pathao: { totalParcels: 4, delivered: 3, cancelled: 1 } } });
  });

  it("calls eCourier with merchant credential headers and reads its status-only answer", async () => {
    const { instance, calls } = harness({ ecourier_api_key: "ecourier-key", ecourier_api_secret: "ecourier-secret", ecourier_user_id: "merchant-user-id" }, {
      body: { customer_status: "Warning!", customer_message: ["This customer has a risky delivery history. Please review before dispatch."] },
    });
    const result = await instance.provider("ecourier", "check", { phone: "+8801911111111" });
    expect(calls[0]!.headers).toMatchObject({ "API-KEY": "ecourier-key", "API-SECRET": "ecourier-secret", "USER-ID": "merchant-user-id" });
    expect(JSON.parse(calls[0]!.body)).toEqual({ number: "01911111111" });
    expect(result.value).toMatchObject({
      riskLevel: "high",
      phone: "01911111111",
      totalParcels: 0,
      delivered: 0,
      cancelled: 0,
      providerStatus: "Warning!",
      message: "This customer has a risky delivery history. Please review before dispatch.",
    });
  });

  it("posts the custom API's phone as a form with the bearer token", async () => {
    const { instance, calls } = harness({ fraudchecker_token: "bearer-token-91" }, { body: { total_parcels: 3, total_delivered: 3, total_cancel: 0 } });
    const result = await instance.provider("fraudchecker", "check", { phone: "+8801711111111" });
    expect(calls[0]!.url).toBe("https://fraudchecker.link/api/v1/qc/");
    expect(calls[0]!.headers.Authorization).toBe("Bearer bearer-token-91");
    expect(calls[0]!.body).toContain('name="phone"\r\n\r\n01711111111\r\n');
    expect(result.value).toMatchObject({ riskLevel: "low", totalParcels: 3 });
  });

  it("fits a long answer to the port instead of failing it", async () => {
    const { instance } = harness(FRAUDBD, { body: { data: { total: 2, success: 1, cancel: 1, customer_status: "x".repeat(200), message: "y".repeat(900) } } });
    const result = await instance.provider("fraudbd", "check", { phone: "+8801711111111" });
    expect(result.ok).toBe(true);
    expect((result.value as { providerStatus: string }).providerStatus).toHaveLength(80);
    expect((result.value as { message: string }).message).toHaveLength(500);
  });

  it("answers refusals with merchant-safe errors and never echoes the service's body", async () => {
    const refused = harness(FRAUDBD, { status: 401, body: { message: "bad key fraudbd-key for +8801711111111" } });
    const result = await refused.instance.provider("fraudbd", "check", { phone: "+8801711111111" });
    expect(result).toMatchObject({ ok: false, error: { category: "misconfigured" } });
    expect(JSON.stringify(result)).not.toMatch(/fraudbd-key|8801711111111/);
    const down = harness(FRAUDBD, Object.assign(new Error("[http.timeout] The request timed out."), { code: "http.timeout" }));
    expect(await down.instance.provider("fraudbd", "check", { phone: "+8801711111111" })).toMatchObject({ ok: false, error: { category: "retryable" } });
  });

  it("refuses an address off the service's hosts or without its credentials, before any request", async () => {
    const elsewhere = harness({ ...FRAUDBD, fraudbd_api_url: "https://evil.example/check" }, { body: {} });
    expect(await elsewhere.instance.provider("fraudbd", "check", { phone: "+8801711111111" })).toMatchObject({ ok: false, error: { category: "misconfigured" } });
    expect(elsewhere.calls).toHaveLength(0);
    const unset = harness({}, { body: {} });
    expect(await unset.instance.provider("fraudguard", "check", { phone: "+8801711111111" })).toMatchObject({ ok: false, error: { category: "misconfigured" } });
    expect(unset.calls).toHaveLength(0);
  });

  it("tests a connection by looking up the test number", async () => {
    const { instance, calls } = harness(FRAUDBD, { body: { data: { total: 0, success: 0, cancel: 0 } } });
    expect(await instance.provider("fraudbd", "testConnection", {})).toMatchObject({ ok: true, value: { ok: true, message: "Connection successful" } });
    expect(JSON.parse(calls[0]!.body)).toEqual({ phone_number: "01700000000" });
    const failing = harness(FRAUDBD, { status: 403, body: {} });
    expect(await failing.instance.provider("fraudbd", "testConnection", {})).toMatchObject({ ok: true, value: { ok: false } });
  });

  it("writes Bangladesh numbers in national form", () => {
    expect(toLocalPhone("+8801711111111")).toBe("01711111111");
    expect(toLocalPhone("+447700900123")).toBe("447700900123");
  });
});
