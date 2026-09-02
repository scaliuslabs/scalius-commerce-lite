import { zodResolver } from "@hookform/resolvers/zod";
import { describe, expect, it } from "vitest";

import {
  collectionFormSchema,
} from "../components/admin/collection-form/types";
import { orderFormSchema } from "../components/admin/order-form/types";

const resolverOptions = {
  fields: {},
  shouldUseNativeValidation: false,
} as const;

describe("admin form resolvers", () => {
  it("returns schema defaults as submitted values", async () => {
    const result = await zodResolver(collectionFormSchema)(
      {
        name: "Summer collection",
        presentation: "grid",
        isActive: false,
        canonicalPath: null,
        noIndex: false,
        excludeFromSitemap: false,
        config: {
          source: "manual",
          categoryIds: [],
          productIds: [],
          showOnHomepage: false,
          maxProducts: 12,
        },
      },
      undefined,
      resolverOptions,
    );

    expect(result.errors).toEqual({});
    expect(result.values).toMatchObject({
      description: null,
      content: null,
      metaTitle: null,
      metaDescription: null,
    });
  });

  it("keeps an order item error on its nested field", async () => {
    const result = await zodResolver(orderFormSchema)(
      {
        customerName: "Test buyer",
        customerPhone: "+8801712345678",
        customerEmail: null,
        shippingAddress: "123 Test Street",
        city: "city_1",
        zone: "zone_1",
        area: null,
        notes: null,
        items: [{ productId: "", variantId: null, quantity: 1, price: 100 }],
        discountAmount: null,
        shippingCharge: 0,
      },
      undefined,
      resolverOptions,
    );

    expect(result.errors.items?.[0]?.productId?.message).toBe(
      "Product is required",
    );
  });
});
