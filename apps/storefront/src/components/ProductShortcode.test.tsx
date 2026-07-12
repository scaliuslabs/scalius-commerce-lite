// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProductShortcode from "./ProductShortcode";
import type { ProductPageData } from "@/lib/api";
import { addToCart } from "@/store/cart";

vi.mock("@/store/cart", () => ({ addToCart: vi.fn(() => true) }));
vi.mock("@/lib/analytics", () => ({ trackFbAddToCart: vi.fn() }));

const option = { id: "format", name: "Format", position: 0, standardMapping: "none" as const, values: [
  { id: "digital", value: "Digital", position: 0 },
  { id: "print", value: "Print", position: 1 },
] };

function data(): ProductPageData {
  const base = {
    productId: "prod_1", optionCombinationKey: "", imageId: null, weight: null, price: 100,
    reservedStock: 0, isDefault: false, trackInventory: true, discountType: null,
    discountPercentage: null, discountAmount: null, createdAt: "2026-01-01", updatedAt: "2026-01-01", deletedAt: null,
  };
  return {
    product: {
      id: "prod_1", name: "Guide", slug: "guide", description: null, price: 100,
      discountType: null, discountPercentage: null, discountAmount: null, discountedPrice: 100,
      freeDelivery: false, isActive: true, metaTitle: null, metaDescription: null,
      categoryId: "cat_1", createdAt: "2026-01-01", updatedAt: "2026-01-01", deletedAt: null,
      hasVariants: true, options: [option],
    },
    category: undefined,
    media: [],
    variants: [
      { ...base, id: "var_digital", optionCombinationKey: "digital", sku: "DIGITAL", stock: 10, selectedOptions: [{ optionDefinitionId: "format", optionValueId: "digital", name: "Format", value: "Digital", position: 0, valuePosition: 0, standardMapping: "none" }] },
      { ...base, id: "var_print", optionCombinationKey: "print", sku: "PRINT", stock: 0, selectedOptions: [{ optionDefinitionId: "format", optionValueId: "print", name: "Format", value: "Print", position: 0, valuePosition: 1, standardMapping: "none" }] },
    ],
    relatedProducts: [],
  };
}

describe("ProductShortcode normalized options", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  afterEach(() => {
    act(() => root.render(<></>));
    vi.clearAllMocks();
  });

  it("renders arbitrary option names and disables sold-out values", () => {
    act(() => root.render(<ProductShortcode productData={data()} />));
    expect(host.textContent).toContain("Format");
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.find((button) => button.textContent === "Print")?.hasAttribute("disabled")).toBe(true);
  });

  it("uses an exact SKU image and falls back to primary for an unmapped SKU", async () => {
    const productData = data();
    productData.media = [
      { id: "pmed_primary", mediaId: "med_primary", kind: "image", url: "https://images.example.com/primary.jpg", posterMediaId: null, posterUrl: null, altText: "Primary", caption: null, width: 800, height: 800, durationMs: null, isPrimary: true, sortOrder: 0, status: "ready" },
      { id: "pmed_digital", mediaId: "med_digital", kind: "image", url: "https://images.example.com/digital.jpg", posterMediaId: null, posterUrl: null, altText: "Digital", caption: null, width: 800, height: 800, durationMs: null, isPrimary: false, sortOrder: 1, status: "ready" },
    ];
    productData.variants[0]!.imageId = "pmed_digital";
    productData.variants[1]!.stock = 10;

    await act(async () => root.render(<ProductShortcode productData={productData} />));
    expect(host.querySelector<HTMLImageElement>('img[alt="Guide"]')?.src).toContain("primary.jpg");

    const digital = [...host.querySelectorAll("button")].find((button) => button.textContent === "Digital");
    await act(async () => digital?.click());
    expect(host.querySelector<HTMLImageElement>('img[alt="Guide"]')?.src).toContain("digital.jpg");
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to Cart"));
    await act(async () => add?.click());
    expect(addToCart).toHaveBeenCalledWith(expect.objectContaining({
      image: "https://images.example.com/digital.jpg",
      imageMediaId: "med_digital",
    }));

    const print = [...host.querySelectorAll("button")].find((button) => button.textContent === "Print");
    await act(async () => print?.click());
    expect(host.querySelector<HTMLImageElement>('img[alt="Guide"]')?.src).toContain("primary.jpg");
  });

  it("renders a featured video poster without putting the video URL in an image", async () => {
    const productData = data();
    productData.product.imageUrl = "https://images.example.com/demo-poster.jpg";
    productData.product.imageMediaId = "med_poster";
    productData.media = [{
      id: "pmed_video",
      mediaId: "med_video",
      kind: "video",
      url: "https://images.example.com/demo.mp4",
      posterMediaId: "med_poster",
      posterUrl: "https://images.example.com/demo-poster.jpg",
      altText: "Video demonstration",
      caption: null,
      width: 1920,
      height: 1080,
      durationMs: 15_000,
      isPrimary: true,
      sortOrder: 0,
      status: "ready",
    }];

    await act(async () => root.render(<ProductShortcode productData={productData} />));

    const source = host.querySelector<HTMLImageElement>('img[alt="Guide"]')?.src;
    expect(source).toContain("demo-poster.jpg");
    expect(source).not.toContain(".mp4");
  });
});
