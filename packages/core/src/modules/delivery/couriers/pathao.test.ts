import { afterEach, describe, expect, it, vi } from "vitest";
import type { CourierShipmentInput } from "@scalius/shared/plugins/providers";
import { pathaoCourier } from "./pathao";

const credentials = {
  baseUrl: "https://courier.invalid",
  clientId: "client",
  clientSecret: "secret",
  username: "merchant",
  password: "password",
};
const config = {
  storeId: "924",
  defaultDeliveryType: 48,
  defaultItemType: 2,
  defaultItemWeight: 0.5,
};
const booking = (codAmountMinor: number): CourierShipmentInput => ({
  idempotencyKey: "shp_1",
  orderId: "order_1",
  recipient: {
    name: "Customer",
    phone: "+8801700000000",
    address: "Address",
    cityId: "city_1",
    zoneId: "zone_1",
    areaId: null,
    cityName: null,
    zoneName: null,
    areaName: null,
    postalCode: null,
    country: null,
  },
  codAmountMinor,
  currency: "BDT",
  decimalPlaces: 2,
  note: null,
  itemCount: null,
  itemDescription: null,
  options: { deliveryType: null, itemType: null, itemWeightKg: null },
});
const call = (db: unknown) => ({ settings: { credentials, config }, signal: new AbortController().signal, db: db as never });

afterEach(() => vi.unstubAllGlobals());

describe("Pathao COD amount", () => {
  it("rejects fractional taka before any provider or location call", async () => {
    const fetchMock = vi.fn();
    const db = { select: vi.fn() };
    vi.stubGlobal("fetch", fetchMock);

    await expect(pathaoCourier.createShipment(booking(557_080), call(db))).rejects.toMatchObject({
      category: "declined",
      uncertain: false,
      message: "Pathao requires a whole-taka COD amount. Use another courier for this balance.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each([0, 50])("keeps whole-taka COD amount %s", async (codAmount) => {
    let locationId = 0;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{
            externalIds: JSON.stringify({ pathao: ++locationId }),
          }]),
        })),
      })),
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/issue-token")) {
        return Response.json({ access_token: "token", expires_in: 7200 });
      }
      expect(JSON.parse(String(init?.body))).toMatchObject({ amount_to_collect: codAmount });
      return Response.json({
        code: 200,
        data: { consignment_id: `consignment_${codAmount}`, order_status: "Pending", delivery_fee: 60 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(pathaoCourier.createShipment(booking(codAmount * 100), call(db))).resolves.toMatchObject({
      externalId: `consignment_${codAmount}`,
      status: "pending",
      rawStatus: "Pending",
      chargeMinor: 6_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
