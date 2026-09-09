import { afterEach, describe, expect, it, vi } from "vitest";
import { PathaoProvider } from "./pathao";

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
const order = {
  id: "order_1",
  customerName: "Customer",
  customerPhone: "+8801700000000",
  shippingAddress: "Address",
  city: "city_1",
  zone: "zone_1",
  area: null,
  totalAmount: 100,
  paidAmount: 0,
  balanceDue: 100,
};

afterEach(() => vi.unstubAllGlobals());

describe("PathaoProvider COD amount", () => {
  it("rejects fractional taka before any provider or location call", async () => {
    const fetchMock = vi.fn();
    const db = { select: vi.fn() };
    vi.stubGlobal("fetch", fetchMock);

    const result = await new PathaoProvider(credentials, config, db as never)
      .createShipment(order as never, { codAmount: 5570.8 });

    expect(result).toEqual({
      success: false,
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
        data: { consignment_id: `consignment_${codAmount}`, order_status: "Pending" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new PathaoProvider(credentials, config, db as never)
      .createShipment(order as never, { codAmount });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
