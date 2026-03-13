import { describe, it, expect } from "vitest";
import {
  createOrderSchema,
  updateOrderSchema,
  bulkDeleteOrderSchema,
  bulkShipOrderSchema,
} from "../orders.validation";

// Helper to build a valid order input object
function validOrderInput() {
  return {
    customerName: "John Doe",
    customerPhone: "01712345678",
    customerEmail: null,
    shippingAddress: "123 Main Street, Apartment 4B, Dhaka",
    city: "city-1",
    zone: "zone-1",
    area: null,
    notes: null,
    items: [
      {
        productId: "prod-1",
        variantId: null,
        quantity: 2,
        price: 500,
      },
    ],
    discountAmount: null,
    shippingCharge: 60,
  };
}

// ─────────────────────────────────────────
// createOrderSchema
// ─────────────────────────────────────────
describe("createOrderSchema", () => {
  describe("valid inputs", () => {
    it("should accept a minimal valid order", () => {
      const input = validOrderInput();
      const result = createOrderSchema.parse(input);
      expect(result.customerName).toBe("John Doe");
      expect(result.shippingCharge).toBe(60);
    });

    it("should standardize the phone number through the schema", () => {
      const input = {
        ...validOrderInput(),
        customerPhone: "+8801712345678",
      };
      const result = createOrderSchema.parse(input);
      expect(result.customerPhone).toBe("01712345678");
    });

    it("should accept a valid email", () => {
      const input = {
        ...validOrderInput(),
        customerEmail: "test@example.com",
      };
      const result = createOrderSchema.parse(input);
      expect(result.customerEmail).toBe("test@example.com");
    });

    it("should accept null email", () => {
      const input = { ...validOrderInput(), customerEmail: null };
      const result = createOrderSchema.parse(input);
      expect(result.customerEmail).toBeNull();
    });

    it("should accept multiple items", () => {
      const input = {
        ...validOrderInput(),
        items: [
          { productId: "prod-1", variantId: null, quantity: 1, price: 100 },
          {
            productId: "prod-2",
            variantId: "var-1",
            quantity: 3,
            price: 250,
          },
        ],
      };
      const result = createOrderSchema.parse(input);
      expect(result.items).toHaveLength(2);
    });

    it("should accept a discount amount", () => {
      const input = { ...validOrderInput(), discountAmount: 50 };
      const result = createOrderSchema.parse(input);
      expect(result.discountAmount).toBe(50);
    });

    it("should accept zero shipping charge", () => {
      const input = { ...validOrderInput(), shippingCharge: 0 };
      const result = createOrderSchema.parse(input);
      expect(result.shippingCharge).toBe(0);
    });

    it("should accept notes", () => {
      const input = {
        ...validOrderInput(),
        notes: "Please deliver before 5pm",
      };
      const result = createOrderSchema.parse(input);
      expect(result.notes).toBe("Please deliver before 5pm");
    });

    it("should accept optional cityName, zoneName, areaName", () => {
      const input = {
        ...validOrderInput(),
        cityName: "Dhaka",
        zoneName: "Mirpur",
        areaName: "Mirpur-10",
      };
      const result = createOrderSchema.parse(input);
      expect(result.cityName).toBe("Dhaka");
      expect(result.zoneName).toBe("Mirpur");
      expect(result.areaName).toBe("Mirpur-10");
    });

    it("should accept zero price on an item", () => {
      const input = {
        ...validOrderInput(),
        items: [
          { productId: "prod-1", variantId: null, quantity: 1, price: 0 },
        ],
      };
      const result = createOrderSchema.parse(input);
      expect(result.items[0].price).toBe(0);
    });
  });

  describe("customerName validation", () => {
    it("should reject name shorter than 3 characters", () => {
      const input = { ...validOrderInput(), customerName: "AB" };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject name longer than 100 characters", () => {
      const input = {
        ...validOrderInput(),
        customerName: "A".repeat(101),
      };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should accept name of exactly 3 characters", () => {
      const input = { ...validOrderInput(), customerName: "Ali" };
      const result = createOrderSchema.parse(input);
      expect(result.customerName).toBe("Ali");
    });
  });

  describe("customerPhone validation", () => {
    it("should reject phone numbers too short", () => {
      const input = { ...validOrderInput(), customerPhone: "0171234" };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject phone numbers too long", () => {
      const input = {
        ...validOrderInput(),
        customerPhone: "012345678901234",
      };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject invalid phone format after standardization", () => {
      const input = { ...validOrderInput(), customerPhone: "99999999999" };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });
  });

  describe("shippingAddress validation", () => {
    it("should reject address shorter than 10 characters", () => {
      const input = { ...validOrderInput(), shippingAddress: "Short" };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject address longer than 500 characters", () => {
      const input = {
        ...validOrderInput(),
        shippingAddress: "A".repeat(501),
      };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });
  });

  describe("city and zone validation", () => {
    it("should reject empty city", () => {
      const input = { ...validOrderInput(), city: "" };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject empty zone", () => {
      const input = { ...validOrderInput(), zone: "" };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });
  });

  describe("notes validation", () => {
    it("should reject notes longer than 500 characters", () => {
      const input = { ...validOrderInput(), notes: "A".repeat(501) };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });
  });

  describe("items validation", () => {
    it("should reject item with empty productId", () => {
      const input = {
        ...validOrderInput(),
        items: [
          { productId: "", variantId: null, quantity: 1, price: 100 },
        ],
      };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject item with quantity less than 1", () => {
      const input = {
        ...validOrderInput(),
        items: [
          { productId: "prod-1", variantId: null, quantity: 0, price: 100 },
        ],
      };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject item with negative price", () => {
      const input = {
        ...validOrderInput(),
        items: [
          { productId: "prod-1", variantId: null, quantity: 1, price: -10 },
        ],
      };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });
  });

  describe("discountAmount validation", () => {
    it("should reject negative discount", () => {
      const input = { ...validOrderInput(), discountAmount: -10 };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should accept zero discount", () => {
      const input = { ...validOrderInput(), discountAmount: 0 };
      const result = createOrderSchema.parse(input);
      expect(result.discountAmount).toBe(0);
    });
  });

  describe("shippingCharge validation", () => {
    it("should reject negative shipping charge", () => {
      const input = { ...validOrderInput(), shippingCharge: -5 };
      expect(() => createOrderSchema.parse(input)).toThrow();
    });
  });

  describe("missing required fields", () => {
    it("should reject when customerName is missing", () => {
      const { customerName, ...input } = validOrderInput();
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject when customerPhone is missing", () => {
      const { customerPhone, ...input } = validOrderInput();
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject when shippingAddress is missing", () => {
      const { shippingAddress, ...input } = validOrderInput();
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject when items is missing", () => {
      const { items, ...input } = validOrderInput();
      expect(() => createOrderSchema.parse(input)).toThrow();
    });

    it("should reject when shippingCharge is missing", () => {
      const { shippingCharge, ...input } = validOrderInput();
      expect(() => createOrderSchema.parse(input)).toThrow();
    });
  });
});

// ─────────────────────────────────────────
// updateOrderSchema
// ─────────────────────────────────────────
describe("updateOrderSchema", () => {
  it("should require a status field in addition to create fields", () => {
    const input = { ...validOrderInput(), status: "confirmed" };
    const result = updateOrderSchema.parse(input);
    expect(result.status).toBe("confirmed");
    expect(result.customerName).toBe("John Doe");
  });

  it("should reject when status is missing", () => {
    const input = validOrderInput();
    expect(() => updateOrderSchema.parse(input)).toThrow();
  });

  it("should reject empty status string", () => {
    const input = { ...validOrderInput(), status: "" };
    expect(() => updateOrderSchema.parse(input)).toThrow();
  });

  it("should accept various status strings", () => {
    const statuses = [
      "pending",
      "confirmed",
      "processing",
      "shipped",
      "delivered",
      "cancelled",
      "returned",
    ];
    for (const status of statuses) {
      const input = { ...validOrderInput(), status };
      const result = updateOrderSchema.parse(input);
      expect(result.status).toBe(status);
    }
  });
});

// ─────────────────────────────────────────
// bulkDeleteOrderSchema
// ─────────────────────────────────────────
describe("bulkDeleteOrderSchema", () => {
  it("should accept valid order IDs array", () => {
    const input = {
      orderIds: ["order-1", "order-2", "order-3"],
      permanent: false,
    };
    const result = bulkDeleteOrderSchema.parse(input);
    expect(result.orderIds).toHaveLength(3);
    expect(result.permanent).toBe(false);
  });

  it("should default permanent to false when omitted", () => {
    const input = { orderIds: ["order-1"] };
    const result = bulkDeleteOrderSchema.parse(input);
    expect(result.permanent).toBe(false);
  });

  it("should accept permanent: true", () => {
    const input = { orderIds: ["order-1"], permanent: true };
    const result = bulkDeleteOrderSchema.parse(input);
    expect(result.permanent).toBe(true);
  });

  it("should accept an empty orderIds array", () => {
    const input = { orderIds: [] };
    const result = bulkDeleteOrderSchema.parse(input);
    expect(result.orderIds).toHaveLength(0);
  });

  it("should reject when orderIds is missing", () => {
    expect(() => bulkDeleteOrderSchema.parse({})).toThrow();
  });
});

// ─────────────────────────────────────────
// bulkShipOrderSchema
// ─────────────────────────────────────────
describe("bulkShipOrderSchema", () => {
  it("should accept valid bulk ship input", () => {
    const input = {
      orderIds: ["order-1", "order-2"],
      providerId: "provider-1",
    };
    const result = bulkShipOrderSchema.parse(input);
    expect(result.orderIds).toHaveLength(2);
    expect(result.providerId).toBe("provider-1");
  });

  it("should accept optional options field", () => {
    const input = {
      orderIds: ["order-1"],
      providerId: "provider-1",
      options: { weight: 2, expedited: true },
    };
    const result = bulkShipOrderSchema.parse(input);
    expect(result.options).toEqual({ weight: 2, expedited: true });
  });

  it("should reject when providerId is missing", () => {
    const input = { orderIds: ["order-1"] };
    expect(() => bulkShipOrderSchema.parse(input)).toThrow();
  });

  it("should reject when orderIds is missing", () => {
    const input = { providerId: "provider-1" };
    expect(() => bulkShipOrderSchema.parse(input)).toThrow();
  });
});
