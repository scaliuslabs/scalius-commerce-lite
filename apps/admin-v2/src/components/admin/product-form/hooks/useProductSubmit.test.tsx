// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  mutateAsync: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({
    isPending: false,
    mutateAsync: mocks.mutateAsync,
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("../utils", () => ({
  formatFormValuesForSubmission: (values: unknown) => values,
}));

vi.mock("~/lib/api-functions/products", () => ({
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
}));

vi.mock("~/lib/api-helpers", () => ({
  getServerFnError: () => "Failed to save product",
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { useProductSubmit } from "./useProductSubmit";
import type { ProductFormValues } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("useProductSubmit", () => {
  let host: HTMLDivElement;
  let root: Root;
  let result: ReturnType<typeof useProductSubmit> | null;

  beforeEach(() => {
    mocks.invalidateQueries.mockReset();
    mocks.mutateAsync.mockReset();
    mocks.navigate.mockReset();
    result = null;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root.render(<HookHarness onResult={(nextResult) => (result = nextResult)} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("does not report success until mutateAsync settles", async () => {
    let resolveMutation: ((value: { id: string }) => void) | undefined;
    mocks.mutateAsync.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveMutation = resolve;
        }),
    );
    let settled = false;

    const submission = requireResult(result)
      .handleSubmit(productValues())
      .then((saved) => {
        settled = true;
        return saved;
      });

    await Promise.resolve();
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    resolveMutation?.({ id: "prod_one" });
    await expect(submission).resolves.toBe(true);
  });

  it("returns false after a failed mutation settles", async () => {
    mocks.mutateAsync.mockRejectedValueOnce(new Error("API unavailable"));

    await expect(
      requireResult(result).handleSubmit(productValues()),
    ).resolves.toBe(false);
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
  });
});

function HookHarness({
  onResult,
}: {
  onResult: (result: ReturnType<typeof useProductSubmit>) => void;
}) {
  const form = {
    getValues: vi.fn(() => productValues()),
    reset: vi.fn(),
    setError: vi.fn(),
  } as unknown as UseFormReturn<ProductFormValues>;
  const result = useProductSubmit({
    isEdit: false,
    enableVariantImages: false,
    variantImageAxis: "option1",
    form,
  });
  onResult(result);
  return null;
}

function requireResult(
  result: ReturnType<typeof useProductSubmit> | null,
): ReturnType<typeof useProductSubmit> {
  if (!result) throw new Error("Hook result is unavailable");
  return result;
}

function productValues(): ProductFormValues {
  return {
    id: "",
    name: "Green Tea",
    description: "Fresh green tea leaves.",
    price: 1200,
    categoryId: "cat_tea",
    isActive: true,
    discountType: "percentage",
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    excludeFromProductFeed: false,
    productCondition: "new",
    variantOption1Label: "Size",
    variantOption2Label: "Color",
    variantOption1Schema: "size",
    variantOption2Schema: "color",
    slug: "green-tea",
    slugEdited: false,
    images: [],
    attributes: [],
    additionalInfo: [],
  };
}
