import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { shopPresentment } from "@scalius/shared/presentment";
import type { CourierRatesInput } from "@scalius/shared/plugins/providers";
import { createCourierProviders } from "./couriers/registry";
import type { Courier } from "./couriers/port";
import { resolveCalculatedDeliveryRates } from "./calculated-rates";
import { resolveDeliveryRate, type DeliveryRateRow } from "./zones";

const money = shopPresentment({ code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 });
const request: CourierRatesInput = {
  destination: { country: "BD", adminArea: null, city: "Dhaka", postalCode: null, placeIds: { city: "city", zone: "zone", area: null } },
  origin: null, parcel: { lines: [{ variantId: "sku", quantity: 1, unitPriceMinor: 10_000, weightGrams: 500 }], weightGrams: 500 },
  currency: "BDT", decimalPlaces: 2, cod: true,
};
const row: DeliveryRateRow = { id: "ship", zoneId: "zone", name: "Delivery", description: null, feeMinor: 0, freeOverMinor: null, isActive: true, rateSource: "example.app:carrier", rateService: null, fallbackFeeMinor: null };
function fixture(rates = vi.fn(async () => ({ rates: [{ service: "standard", name: "Standard", amountMinor: 6_000, estimatedDays: null }] }))) {
  const courier = { id: row.rateSource!, countries: ["BD"], rates } as unknown as Courier;
  return {
    rates,
    input: { db: {} as Database, rows: [row], request, money, locationRows: [], methodId: row.id,
      options: { masterSecret: "a".repeat(48), couriers: createCourierProviders([courier]) } },
  };
}

describe("calculated delivery rates", () => {
  it("locks a price for the same parcel/destination without recalling the courier", async () => {
    const { input, rates } = fixture();
    const quoted = await resolveCalculatedDeliveryRates(input);
    expect(quoted[0]).toMatchObject({ feeMinor: 6_000, rateCurrency: "BDT", rateToken: expect.any(String) });
    await resolveCalculatedDeliveryRates({ ...input, token: quoted[0]!.rateToken });
    expect(rates).toHaveBeenCalledTimes(1);
    const committed = await resolveCalculatedDeliveryRates({ ...input, token: quoted[0]!.rateToken,
      request: { ...request, cod: false }, options: { ...input.options, acceptQuotedCod: true } });
    expect(committed[0]?.rateCod).toBe(true);
    expect(rates).toHaveBeenCalledTimes(1);
    const changed = await resolveCalculatedDeliveryRates({ ...input, token: quoted[0]!.rateToken, request: { ...request, cod: false } });
    expect(changed[0]?.feeMinor).toBe(6_000);
    expect(rates).toHaveBeenCalledTimes(2);
  });
  it("rejects tampered, expired and another destination's proof", async () => {
    vi.useFakeTimers();
    try {
      const { input, rates } = fixture();
      const token = (await resolveCalculatedDeliveryRates(input))[0]!.rateToken!;
      await resolveCalculatedDeliveryRates({ ...input, token: `${token.slice(0, -4)}AAAA` });
      await resolveCalculatedDeliveryRates({ ...input, token, request: { ...request, destination: { ...request.destination, city: "Chattogram" } } });
      vi.setSystemTime(Date.now() + 901_000);
      await resolveCalculatedDeliveryRates({ ...input, token });
      expect(rates).toHaveBeenCalledTimes(4);
    } finally { vi.useRealTimers(); }
  });
  it("uses explicit fallback or hides unavailable rates, never the configured zero fee", async () => {
    const { input } = fixture(vi.fn(async () => { throw new Error("unavailable"); }));
    expect(await resolveCalculatedDeliveryRates(input)).toEqual([]);
    const answer = await resolveCalculatedDeliveryRates({ ...input, rows: [{ ...row, fallbackFeeMinor: 8_000 }] });
    expect(answer[0]).toMatchObject({ feeMinor: 8_000, rateToken: expect.any(String) });
    expect(() => resolveDeliveryRate({ rate: row, addressZoneId: "zone", subtotalMinor: 10_000 })).toThrow();
  });
  it("bounds provider work to three calls and memoizes methods of one provider", async () => {
    const rates = vi.fn(async () => ({ rates: [{ service: "standard", name: "Standard", amountMinor: 6_000, estimatedDays: null }] }));
    const { input } = fixture(rates);
    const rows = ["one", "one", "two", "three", "four"].map((id, index) => ({ ...row, id: String(index), rateSource: `example.app:${id}`, fallbackFeeMinor: 9_000 }));
    const couriers = createCourierProviders(["one", "two", "three", "four"].map((id) => ({ id: `example.app:${id}`, countries: "any", rates }) as unknown as Courier));
    expect(await resolveCalculatedDeliveryRates({ ...input, rows, options: { ...input.options, couriers } })).toHaveLength(5);
    expect(rates).toHaveBeenCalledTimes(3);
  });
  it("ends an unresponsive provider at the shared deadline", async () => {
    const { input } = fixture(vi.fn(() => new Promise<never>(() => undefined)));
    const start = Date.now();
    const rows = await resolveCalculatedDeliveryRates({ ...input, rows: [{ ...row, fallbackFeeMinor: 7_000 }] });
    expect(rows[0]?.feeMinor).toBe(7_000);
    expect(Date.now() - start).toBeLessThan(2_500);
  });
});
