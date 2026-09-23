// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createClient, createConfig } from "@scalius/api-client/factory";

const requests = vi.hoisted(() => [] as Request[]);

vi.mock("./transport", () => ({
  getConfiguredSdkClient: () =>
    createClient(createConfig({
      baseUrl: "https://api.example.test",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json({ success: true, data: { valid: true } });
      },
    })),
}));

import { validateDiscount } from "./discounts";

describe("validateDiscount", () => {
  it("sends the code, cart, and buyer phone only in a POST body", async () => {
    const result = await validateDiscount(
      "SAVE10",
      [{ id: "prod_1", variantId: "var_1", price: 600, quantity: 2 } as never],
      60,
      "+8801712345678",
    );

    expect(result).toEqual({ valid: true });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.method).toBe("POST");
    expect(new URL(request!.url).search).toBe("");
    expect(request!.url).not.toMatch(/SAVE10|8801712345678|prod_1/);
    expect(await request!.json()).toEqual({
      code: "SAVE10",
      shippingCost: 60,
      customerPhone: "+8801712345678",
      items: [{ id: "prod_1", variantId: "var_1", price: 600, quantity: 2 }],
    });
  });
});
