/** Tests only: feed rows and layouts the UCP tests share. */
import type { Product } from "@/lib/api/types";
import type { UcpCatalogContext } from "./catalog";

export const UCP_TEST_BASE_URL = "https://storefront.example.test";

export function ucpTestContext(overrides: Partial<UcpCatalogContext> = {}): UcpCatalogContext {
  return {
    baseUrl: UCP_TEST_BASE_URL,
    presence: "",
    currency: { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
    messages: [],
    policies: [],
    seller: null,
    ...overrides,
  };
}

/** A two-SKU feed row (prices in the answered market's major units, as the feed sends them). */
export function ucpFeedProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "prod_1",
    name: "Khaki Shoes",
    slug: "khaki-shoes",
    canonicalPath: null,
    description: "<p>Comfortable <strong>shoes</strong></p>",
    price: 1500,
    discountType: null,
    discountPercentage: null,
    discountAmount: null,
    discountedPrice: 1500,
    freeDelivery: true,
    isActive: true,
    metaTitle: null,
    metaDescription: null,
    options: [
      { id: "weight", name: "Weight", position: 0, standardMapping: "none", values: [{ id: "2kg", value: "2KG", position: 0 }, { id: "3kg", value: "3KG", position: 1 }] },
      { id: "style", name: "Style", position: 1, standardMapping: "none", values: [{ id: "red", value: "Red", position: 0 }, { id: "blue", value: "Blue", position: 1 }] },
    ],
    categoryId: "cat_1",
    category: { id: "cat_1", name: "Shoes", slug: "shoes" },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    deletedAt: null,
    imageUrl: "/images/shoe.jpg",
    imageAlt: "Khaki shoe",
    hasVariants: true,
    availableForSale: true,
    attributes: [],
    variants: [
      {
        id: "var_1",
        productId: "prod_1",
        optionCombinationKey: "2kg|red",
        imageId: null,
        selectedOptions: [
          { optionDefinitionId: "weight", optionValueId: "2kg", name: "Weight", value: "2KG", position: 0, valuePosition: 0, standardMapping: "none" },
          { optionDefinitionId: "style", optionValueId: "red", name: "Style", value: "Red", position: 1, valuePosition: 0, standardMapping: "none" },
        ],
        weight: null,
        sku: "SKU-RED",
        price: 1200,
        stock: 3,
        reservedStock: 1,
        isDefault: false,
        trackInventory: true,
        barcode: "1234567890123",
        barcodeType: "ean13",
        discountType: "flat",
        discountAmount: 100,
        discountPercentage: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        deletedAt: null,
      },
      {
        id: "var_2",
        productId: "prod_1",
        optionCombinationKey: "3kg|blue",
        imageId: null,
        selectedOptions: [
          { optionDefinitionId: "weight", optionValueId: "3kg", name: "Weight", value: "3KG", position: 0, valuePosition: 1, standardMapping: "none" },
          { optionDefinitionId: "style", optionValueId: "blue", name: "Style", value: "Blue", position: 1, valuePosition: 1, standardMapping: "none" },
        ],
        weight: null,
        sku: "SKU-BLUE",
        price: 1600,
        stock: 0,
        reservedStock: 0,
        isDefault: false,
        trackInventory: false,
        barcode: null,
        barcodeType: null,
        discountType: null,
        discountAmount: null,
        discountPercentage: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        deletedAt: null,
      },
    ],
    ...overrides,
  };
}

/** A feed page of these rows. */
export function ucpFeedPage(products: Product[]) {
  return { data: products, pagination: { limit: 10, hasNextPage: false } };
}

/** A store with a root (Bangladesh, BDT, `/bn` too) and an India market in USD at `/en-in`. */
export const UCP_TEST_MARKETS = {
  markets: [
    {
      id: "mkt_backup",
      handle: "bangladesh",
      name: "Bangladesh",
      isBackup: true,
      countries: ["BD"],
      presences: [{ value: "", locale: "en" }, { value: "bn", locale: "bn" }],
    },
    {
      id: "mkt_in",
      handle: "india",
      name: "India",
      isBackup: false,
      currencyCode: "USD",
      countries: ["IN"],
      presences: [{ value: "en-in", locale: "en" }],
    },
  ],
};
