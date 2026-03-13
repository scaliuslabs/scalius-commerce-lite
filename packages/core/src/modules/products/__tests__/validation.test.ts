import { describe, it, expect } from "vitest";
import {
  createProductSchema,
  updateProductSchema,
} from "../products.validation";

// Helper to build a valid product input object
function validProductInput() {
  return {
    name: "Test Product",
    description: "A valid product description for testing",
    price: 1999,
    categoryId: "cat-123",
    isActive: true,
    freeDelivery: false,
    metaTitle: "Test Product SEO Title",
    metaDescription: "Test Product SEO Description",
    slug: "test-product",
    images: [
      {
        id: "img-1",
        url: "https://example.com/image.jpg",
        filename: "image.jpg",
        size: 1024,
        createdAt: new Date("2024-01-01"),
      },
    ],
  };
}

// ─────────────────────────────────────────
// createProductSchema
// ─────────────────────────────────────────
describe("createProductSchema", () => {
  describe("valid inputs", () => {
    it("should accept a minimal valid product", () => {
      const input = validProductInput();
      const result = createProductSchema.parse(input);
      expect(result.name).toBe("Test Product");
      expect(result.price).toBe(1999);
    });

    it("should accept null description", () => {
      const input = { ...validProductInput(), description: null };
      const result = createProductSchema.parse(input);
      expect(result.description).toBeNull();
    });

    it("should accept null metaTitle and metaDescription", () => {
      const input = {
        ...validProductInput(),
        metaTitle: null,
        metaDescription: null,
      };
      const result = createProductSchema.parse(input);
      expect(result.metaTitle).toBeNull();
      expect(result.metaDescription).toBeNull();
    });

    it("should accept optional discount fields", () => {
      const input = {
        ...validProductInput(),
        discountType: "percentage" as const,
        discountPercentage: 10,
        discountAmount: null,
      };
      const result = createProductSchema.parse(input);
      expect(result.discountType).toBe("percentage");
      expect(result.discountPercentage).toBe(10);
    });

    it("should accept flat discount type", () => {
      const input = {
        ...validProductInput(),
        discountType: "flat" as const,
        discountAmount: 500,
      };
      const result = createProductSchema.parse(input);
      expect(result.discountType).toBe("flat");
      expect(result.discountAmount).toBe(500);
    });

    it("should accept product with attributes", () => {
      const input = {
        ...validProductInput(),
        attributes: [
          { attributeId: "attr-1", value: "Red" },
          { attributeId: "attr-2", value: "Large" },
        ],
      };
      const result = createProductSchema.parse(input);
      expect(result.attributes).toHaveLength(2);
    });

    it("should accept product with additional info", () => {
      const input = {
        ...validProductInput(),
        additionalInfo: [
          {
            id: "info-1",
            title: "Material",
            content: "100% Cotton",
            sortOrder: 0,
          },
        ],
      };
      const result = createProductSchema.parse(input);
      expect(result.additionalInfo).toHaveLength(1);
    });

    it("should accept empty images array", () => {
      const input = { ...validProductInput(), images: [] };
      const result = createProductSchema.parse(input);
      expect(result.images).toHaveLength(0);
    });

    it("should accept price of 0", () => {
      const input = { ...validProductInput(), price: 0 };
      const result = createProductSchema.parse(input);
      expect(result.price).toBe(0);
    });

    it("should accept max price", () => {
      const input = { ...validProductInput(), price: 1000000000000 };
      const result = createProductSchema.parse(input);
      expect(result.price).toBe(1000000000000);
    });

    it("should coerce string dates in images to Date objects", () => {
      const input = {
        ...validProductInput(),
        images: [
          {
            id: "img-1",
            url: "https://example.com/image.jpg",
            filename: "image.jpg",
            size: 1024,
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ],
      };
      const result = createProductSchema.parse(input);
      expect(result.images[0].createdAt).toBeInstanceOf(Date);
    });
  });

  describe("name validation", () => {
    it("should reject name shorter than 3 characters", () => {
      const input = { ...validProductInput(), name: "AB" };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject name longer than 100 characters", () => {
      const input = { ...validProductInput(), name: "A".repeat(101) };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should accept name of exactly 3 characters", () => {
      const input = { ...validProductInput(), name: "ABC" };
      const result = createProductSchema.parse(input);
      expect(result.name).toBe("ABC");
    });

    it("should accept name of exactly 100 characters", () => {
      const input = { ...validProductInput(), name: "A".repeat(100) };
      const result = createProductSchema.parse(input);
      expect(result.name).toHaveLength(100);
    });
  });

  describe("description validation", () => {
    it("should reject description shorter than 10 characters", () => {
      const input = { ...validProductInput(), description: "Short" };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should accept description of exactly 10 characters", () => {
      const input = { ...validProductInput(), description: "1234567890" };
      const result = createProductSchema.parse(input);
      expect(result.description).toBe("1234567890");
    });
  });

  describe("price validation", () => {
    it("should reject negative price", () => {
      const input = { ...validProductInput(), price: -1 };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject price exceeding max", () => {
      const input = { ...validProductInput(), price: 1000000000001 };
      expect(() => createProductSchema.parse(input)).toThrow();
    });
  });

  describe("slug validation", () => {
    it("should accept a valid slug", () => {
      const input = { ...validProductInput(), slug: "my-product-123" };
      const result = createProductSchema.parse(input);
      expect(result.slug).toBe("my-product-123");
    });

    it("should reject slug with uppercase letters", () => {
      const input = { ...validProductInput(), slug: "My-Product" };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject slug with spaces", () => {
      const input = { ...validProductInput(), slug: "my product" };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject slug with consecutive hyphens", () => {
      const input = { ...validProductInput(), slug: "my--product" };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject slug starting with a hyphen", () => {
      const input = { ...validProductInput(), slug: "-product" };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject slug ending with a hyphen", () => {
      const input = { ...validProductInput(), slug: "product-" };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject slug shorter than 3 characters", () => {
      const input = { ...validProductInput(), slug: "ab" };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject slug with special characters", () => {
      const input = { ...validProductInput(), slug: "my_product!" };
      expect(() => createProductSchema.parse(input)).toThrow();
    });
  });

  describe("discount validation", () => {
    it("should reject invalid discount type", () => {
      const input = {
        ...validProductInput(),
        discountType: "invalid" as any,
      };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject discount percentage over 100", () => {
      const input = {
        ...validProductInput(),
        discountType: "percentage" as const,
        discountPercentage: 101,
      };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject negative discount percentage", () => {
      const input = {
        ...validProductInput(),
        discountType: "percentage" as const,
        discountPercentage: -5,
      };
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject negative discount amount", () => {
      const input = {
        ...validProductInput(),
        discountType: "flat" as const,
        discountAmount: -100,
      };
      expect(() => createProductSchema.parse(input)).toThrow();
    });
  });

  describe("categoryId validation", () => {
    it("should reject empty categoryId", () => {
      const input = { ...validProductInput(), categoryId: "" };
      expect(() => createProductSchema.parse(input)).toThrow();
    });
  });

  describe("missing required fields", () => {
    it("should reject when name is missing", () => {
      const { name, ...input } = validProductInput();
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject when price is missing", () => {
      const { price, ...input } = validProductInput();
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject when slug is missing", () => {
      const { slug, ...input } = validProductInput();
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject when images is missing", () => {
      const { images, ...input } = validProductInput();
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject when isActive is missing", () => {
      const { isActive, ...input } = validProductInput();
      expect(() => createProductSchema.parse(input)).toThrow();
    });

    it("should reject when freeDelivery is missing", () => {
      const { freeDelivery, ...input } = validProductInput();
      expect(() => createProductSchema.parse(input)).toThrow();
    });
  });
});

// ─────────────────────────────────────────
// updateProductSchema
// ─────────────────────────────────────────
describe("updateProductSchema", () => {
  it("should require an id field in addition to base fields", () => {
    const input = { ...validProductInput(), id: "prod-123" };
    const result = updateProductSchema.parse(input);
    expect(result.id).toBe("prod-123");
    expect(result.name).toBe("Test Product");
  });

  it("should reject when id is missing", () => {
    const input = validProductInput();
    expect(() => updateProductSchema.parse(input)).toThrow();
  });

  it("should apply the same base validations as create", () => {
    const input = { ...validProductInput(), id: "prod-123", name: "AB" };
    expect(() => updateProductSchema.parse(input)).toThrow();
  });
});
